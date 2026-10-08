// Debug runs in the build sandbox (PRD §11, §14.1a; M5 W1). Same isolation as the coverage
// lane: the stack's pinned image, the approved recipe's install (offline from the dependency
// cache unless the scope is `network`), a read-only source, no capabilities, resource limits.
//
// A run copies one worktree (the approved commit, or a bisect candidate), installs, and runs one
// of the debug's own scripts. Its exit code is read with the git-bisect-run contract; an install
// that fails means the run can't tell (skip), and a sandbox that fails to run at all is an error.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { hashBytes } from "../core/determinism.js";
import { RefusedError, UsageError } from "../core/errors.js";
import type { EngagementDoc } from "../engagement/config.js";
import type { Layout } from "../engagement/home.js";
import { CACHE_MOUNT, NODE_TOOLS_MOUNT, nodeInstall, pythonInstall } from "../sandbox/recipe.js";
import { detectRuntime, imageRef, runSandbox, type Mount, type Runtime, type SandboxRequest, type SandboxResult } from "../sandbox/runtime.js";
import { stackImages } from "../sandbox/stack-images.js";
import { drivers } from "../sandbox/stacks.js";
import { nodeToolsDir } from "../toolchain/install.js";
import type { EventLog } from "../state/events.js";
import { outcomeOf, nextId, type RunKind, type RunOutcome } from "./state.js";

const DEBUG_TIMEOUT_MS = 30 * 60 * 1000;
const SCRIPT_MOUNT = "/radr/debug";

export type SandboxRunner = (req: SandboxRequest, outDir: string) => Promise<SandboxResult>;

/** Everything a debug run needs about the sandbox, resolved once from the approved scope. */
export interface DebugSandbox {
  readonly runtime: Runtime;
  readonly stack: string;
  /** Project directory (relative to the repo) the script runs in. */
  readonly dir: string;
  readonly image: string;
  readonly install: string;
  /** Prefix for every script step (Python: activate the venv the install created). */
  readonly prelude: string;
  readonly env: Readonly<Record<string, string>>;
  readonly online: boolean;
  readonly mounts: readonly Mount[];
  readonly runner: SandboxRunner;
}

/** Stacks with an approved build recipe, in recipe order. */
export function recipeStacks(doc: EngagementDoc): string[] {
  return Object.keys(doc.build ?? {}).filter((s) => doc.stacks.includes(s as EngagementDoc["stacks"][number]));
}

export async function debugSandbox(home: string, l: Layout, doc: EngagementDoc, env: NodeJS.ProcessEnv, depsCache: string | null, stack?: string): Promise<DebugSandbox> {
  const stacks = recipeStacks(doc);
  if (stacks.length === 0) throw new RefusedError("debug runs need an approved build recipe (engagement.yml `build`); none is set");
  const chosen = stack ?? (stacks.length === 1 ? stacks[0] : undefined);
  if (chosen === undefined) throw new UsageError(`this scope has recipes for ${stacks.join(", ")}: pick one with --stack`);
  if (!stacks.includes(chosen)) throw new UsageError(`no approved build recipe for stack "${chosen}" (have: ${stacks.join(", ")})`);
  const runtime = await detectRuntime(env);
  if (runtime === undefined) throw new RefusedError("debug runs client code in the build sandbox: no container runtime is reachable (start Podman or Docker)");
  const online = doc.network.mode === "network";
  if (!online && depsCache === null) throw new RefusedError("no dependency snapshot is pinned for this offline scope (run `radr deps warm`, then re-scope)");
  const mounts: Mount[] = [];
  if (!online && depsCache !== null) mounts.push({ host: depsCache, container: CACHE_MOUNT, readOnly: true });
  const mode = online ? "online" : "offline";
  const b = doc.build ?? {};

  if (chosen === "typescript-javascript" || chosen === "python") {
    const node = b["typescript-javascript"];
    const py = b.python;
    if (chosen === "typescript-javascript" && node !== undefined) {
      mounts.push({ host: nodeToolsDir(home), container: NODE_TOOLS_MOUNT, readOnly: true });
      return { runtime, stack: chosen, dir: node.dir, image: imageRef("node"), install: nodeInstall(mode), prelude: "", env: {}, online, mounts, runner: runSandbox };
    }
    if (py !== undefined) return { runtime, stack: chosen, dir: py.dir, image: imageRef("python"), install: pythonInstall(py, mode), prelude: ". /tmp/venv/bin/activate && ", env: {}, online, mounts, runner: runSandbox };
  }
  const d = drivers(doc.build, doc.stacks, online).find((x) => x.driver.stack === chosen);
  if (d === undefined) throw new RefusedError(`no sandbox driver for stack "${chosen}"`);
  const image = stackImages(home)[chosen === "csharp" ? `csharp-${d.dotnetSdk}` : chosen];
  if (image === undefined) throw new RefusedError(`the ${chosen} sandbox image isn't built (radr tools build-image --stack ${chosen})`);
  return { runtime, stack: chosen, dir: d.recipe.dir, image, install: d.driver.install(mode), prelude: "", env: d.driver.env(mode), online, mounts, runner: runSandbox };
}

export interface RunSpec {
  readonly debugId: string;
  readonly kind: RunKind;
  /** The commit `worktree` holds. */
  readonly commit: string;
  /** A read-only checkout of `commit`. */
  readonly worktree: string;
  /** The script to run (repro/repro.sh, experiments/<name>.sh, …). */
  readonly script: string;
  readonly hypothesisId?: string;
}

export interface RunResult {
  readonly runId: string;
  readonly outcome: RunOutcome;
  readonly exitCode: number | null;
  readonly logRef: string;
  readonly scriptHash: string;
}

/** Hash of a debug script as it is now (what a run would record). */
export function scriptHash(file: string): string {
  if (!existsSync(file)) throw new UsageError(`${file} not found`);
  return hashBytes(readFileSync(file));
}

/** Run one debug script in a fresh sandbox and record a `debug-run` event. */
export async function runDebugScript(l: Layout, log: EventLog, actor: string, sb: DebugSandbox, spec: RunSpec): Promise<RunResult> {
  const hashNow = scriptHash(spec.script);
  const runId = nextId(log.read(), "DR");
  const outDir = path.join(l.debug, spec.debugId, "runs", runId);
  mkdirSync(outDir, { recursive: true });
  const name = path.basename(spec.script);
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new UsageError(`script name "${name}" may use only letters, digits, ".", "_" and "-"`);
  const r = await sb.runner({
    runtime: sb.runtime, image: sb.image, name: `radr-${l.id}-${runId}`.toLowerCase(), network: sb.online,
    mounts: [
      { host: spec.worktree, container: "/src", readOnly: true },
      { host: outDir, container: "/radr/out", readOnly: false },
      { host: path.dirname(spec.script), container: SCRIPT_MOUNT, readOnly: true },
      ...sb.mounts,
    ],
    workdir: sb.dir,
    steps: [{ name: "install", command: sb.install, required: true }, { name: "script", command: `${sb.prelude}sh ${SCRIPT_MOUNT}/${name}`, required: false }],
    env: sb.env, timeoutMs: DEBUG_TIMEOUT_MS,
  }, outDir);

  const codes = new Map(r.steps.map((s) => [s.name, s.exitCode]));
  const exitCode = codes.get("script") ?? null;
  let outcome: RunOutcome;
  let detail: string | undefined;
  if (r.exec.outcome !== "ok") {
    outcome = "error";
    detail = r.exec.outcome === "timeout" ? "sandbox timed out" : (r.exec.error ?? r.exec.stderr.toString().trim().split("\n").at(-1) ?? r.exec.outcome);
  } else if (codes.get("install") !== 0) {
    outcome = "skip";
    detail = `install failed at this commit (exit ${String(codes.get("install") ?? "none")}): can't tell`;
  } else {
    outcome = outcomeOf(exitCode);
  }
  const logFile = path.join(outDir, exitCode === null ? "install.log" : "script.log");
  const logRef = path.relative(l.dir, logFile).split(path.sep).join("/");
  log.append("debug-run", actor, {
    debug_id: spec.debugId, run_id: runId, kind: spec.kind, commit: spec.commit, script_hash: hashNow, exit_code: exitCode, outcome,
    log_ref: logRef, log_hash: hashBytes(existsSync(logFile) ? readFileSync(logFile) : Buffer.alloc(0)),
    ...(spec.hypothesisId !== undefined ? { hypothesis_id: spec.hypothesisId } : {}),
    ...(detail !== undefined ? { detail: detail.slice(0, 500) } : {}),
  });
  return { runId, outcome, exitCode, logRef, scriptHash: hashNow };
}
