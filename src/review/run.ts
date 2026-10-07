// `radr review` (T4.1): run the approved scope's lanes and ingest findings.
//
// Before EVERY lane attempt: the scope gate must be open, the fingerprint must still match, and
// the worktree must be exactly the approved SHA (AC9). Every lane outcome resolves through
// policy/matrix.yml; nothing here decides what happens next on its own.

import path from "node:path";
import type { Clock } from "../core/clock.js";
import { assetPath } from "../core/assets.js";
import { RefusedError } from "../core/errors.js";
import type { EngagementDoc } from "../engagement/config.js";
import type { Layout } from "../engagement/home.js";
import { verifyWorktree } from "../engagement/source.js";
import { ingest } from "../findings/store.js";
import type { FindingDraft } from "../findings/types.js";
import { LANES } from "../lanes/builtin.js";
import type { LaneOutcome, Toolbox } from "../lanes/lane.js";
import { Matrix, runStatus } from "../matrix/matrix.js";
import { autoConfirms, loadRubric, type Rubric } from "../rubric/rubric.js";
import { dispositions, stateOf } from "../findings/disposition.js";
import type { Finding } from "../findings/types.js";
import { canonicalJson, hashBytes, stableSort } from "../core/determinism.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { loadVulnContext } from "../toolchain/vulnctx.js";
import { EventLog } from "../state/events.js";
import { readScopeInputs, scopeFingerprint } from "../state/fingerprint.js";
import { Gates } from "../state/gates.js";
import { osvRoot, readSnapshotsLock, verifySnapshot } from "../toolchain/db.js";
import { buildLock, diffLocks, doctor, readLock, type ToolCheck, type ToolchainLock } from "../toolchain/doctor.js";
import { nodeToolsDir, pyToolsDir } from "../toolchain/install.js";
import { detectRuntime, sandboxLockEntry, type Runtime } from "../sandbox/runtime.js";
import { verifyDeps } from "../sandbox/deps.js";
import { assertSafeImage, containerExec, hostExec, type ContainerMount } from "../toolchain/container.js";
import { IMAGE_CONFIGS, IMAGE_NODE, IMAGE_NODE_TOOLS, IMAGE_PY, imageBins, imageId, pyToolVersions } from "../toolchain/image.js";
import { SANDBOX_LANES } from "../engagement/config.js";

export interface LaneSummary {
  readonly lane: string;
  readonly outcome: LaneOutcome;
  readonly action: string;
  readonly attempts: number;
  readonly findings: number;
  readonly detail?: string;
}

export interface ReviewResult {
  readonly runId: string;
  readonly status: "complete" | "partial" | "aborted";
  readonly lanes: readonly LaneSummary[];
  readonly findings: number;
  readonly added: number;
  readonly setHash: string | null;
  readonly census?: Readonly<Record<string, unknown>>;
  readonly autoConfirmed?: number;
  /** Fail-open gaps (P7), e.g. no EPSS/KEV snapshot pinned. */
  readonly notes?: readonly string[];
}

/** Throws RefusedError unless the scope gate is open for the CURRENT scope and worktree. */
async function assertScope(l: Layout, gates: Gates, log: EventLog): Promise<{ doc: EngagementDoc; fingerprint: string }> {
  const inputs = readScopeInputs(l);
  const fingerprint = scopeFingerprint(inputs);
  const g = gates.evaluate("scope", log.read(), { fingerprint });
  if (!g.passed) throw new RefusedError(g.reason);
  await verifyWorktree(l.worktree, inputs.engagement.source.sha);
  return { doc: inputs.engagement, fingerprint };
}

interface ToolProblems {
  /** tool → the lane outcome its problem maps to. */
  readonly byTool: ReadonlyMap<string, "tool-missing" | "version-drift">;
  readonly lines: readonly string[];
}

/** Tools that are missing, or whose live state differs from the engagement's toolchain.lock. */
function toolProblems(l: Layout, checks: readonly ToolCheck[], liveSandbox: ToolchainLock["sandbox"]): ToolProblems {
  const byTool = new Map<string, "tool-missing" | "version-drift">();
  const unhealthy = checks.filter((c) => c.state !== "ok");
  if (unhealthy.length > 0) {
    for (const c of unhealthy) byTool.set(c.tool, c.state === "missing" ? "tool-missing" : "version-drift");
    return { byTool, lines: unhealthy.map((c) => `${c.tool}: ${c.state} (${c.detail})`) };
  }
  const lines = diffLocks(readLock(l.toolchainLock), buildLock(checks, liveSandbox));
  for (const line of lines) {
    const name = line.split(":")[0] ?? "";
    if (name.startsWith("config ruff")) byTool.set("ruff", "version-drift");
    else if (name.startsWith("config rules")) byTool.set("opengrep", "version-drift"); // the rule pack changed
    else if (name.startsWith("config eslint") || name === "node-tools") byTool.set("node-tools", "version-drift");
    else if (name === "platform") for (const c of checks) byTool.set(c.tool, "version-drift");
    else if (name === "sandbox") byTool.set("sandbox", liveSandbox === null ? "tool-missing" : "version-drift");
    else byTool.set(name, "version-drift");
  }
  return { byTool, lines };
}

function snapshotsFor(home: string, l: Layout): { osvDb: string | null; depsCache: string | null } {
  const snaps = readSnapshotsLock(l.snapshotsLock);
  let osvDb: string | null = null;
  if (snaps.osv !== null) {
    verifySnapshot(home, snaps.osv.id);
    osvDb = path.join(osvRoot(home), snaps.osv.id);
  }
  const deps = snaps.deps;
  return { osvDb, depsCache: deps === undefined || deps === null ? null : verifyDeps(home, l.id, deps.id) };
}

function hostToolbox(home: string, l: Layout, checks: readonly ToolCheck[], runtime: Runtime | undefined): Toolbox {
  const bins: Record<string, string> = {};
  const versions: Record<string, string> = {};
  for (const c of checks) {
    if (c.binPath !== undefined && c.tool !== "node-tools") bins[c.tool] = c.binPath;
    versions[c.tool] = c.version;
  }
  const { osvDb, depsCache } = snapshotsFor(home, l);
  return {
    bins, versions, nodeTools: nodeToolsDir(home), node: process.execPath, osvDb, ruffConfig: assetPath("toolchain/configs/ruff/ruff.toml"), rulesDir: assetPath("rules"),
    python: bins["lizard"] ?? "/nonexistent/python3", pythonPath: path.join(pyToolsDir(home), "site"),
    exec: hostExec(), sandbox: runtime === undefined ? null : { runtime, depsCache, nodeTools: nodeToolsDir(home) },
  };
}

/** Container mode (M3, AC2): tools run in the locked image; paths are the image's, mounts same-path. */
function containerToolbox(home: string, l: Layout, lock: ToolchainLock, runtime: Runtime): Toolbox {
  const image = lock.image;
  if (image === undefined || image === null) throw new RefusedError("toolchain.lock has no image (re-scope after `radr tools build-image`)");
  const platform = lock.platform === "linux-x64" ? "linux-x64" : "linux-arm64";
  const versions: Record<string, string> = {};
  for (const [tool, t] of Object.entries(lock.tools)) versions[tool] = t.version;
  versions["node-tools"] = lock.node_tools.eslint_version;
  Object.assign(versions, pyToolVersions());
  const { osvDb, depsCache } = snapshotsFor(home, l);
  const mounts: ContainerMount[] = [
    { path: l.dir, readOnly: false },
    { path: path.join(l.dir, "source"), readOnly: true },
    ...(existsSync(path.join(home, "snapshots")) ? [{ path: path.join(home, "snapshots"), readOnly: true }] : []),
    { path: assetPath("rules"), readOnly: true }, // same rules in both modes
  ];
  return {
    bins: imageBins(platform), versions, nodeTools: IMAGE_NODE_TOOLS, node: IMAGE_NODE, osvDb, ruffConfig: `${IMAGE_CONFIGS}/ruff.toml`, rulesDir: assetPath("rules"),
    python: `${IMAGE_PY}/bin/python`, pythonPath: null,
    exec: containerExec(runtime, assertSafeImage(image.tag), mounts),
    sandbox: { runtime, depsCache, nodeTools: nodeToolsDir(home) },
  };
}

/** Image problems for container mode: missing runtime/image → tool-missing; different image → drift. */
async function imageProblem(lock: ToolchainLock, runtime: Runtime | undefined): Promise<{ outcome: "tool-missing" | "version-drift"; detail: string } | undefined> {
  const image = lock.image;
  if (image === undefined || image === null) return { outcome: "tool-missing", detail: "toolchain.lock has no image" };
  if (runtime === undefined) return { outcome: "tool-missing", detail: "no container runtime reachable for container mode" };
  const live = await imageId(runtime, image.tag);
  if (live === undefined) return { outcome: "tool-missing", detail: `toolchain image ${image.tag} not found (run \`radr tools build-image\`)` };
  if (live !== image.id) return { outcome: "version-drift", detail: `toolchain image ${image.tag} is ${live}, locked ${image.id}` };
  return undefined;
}

export async function review(home: string, l: Layout, actor: string, clock: Clock, env: NodeJS.ProcessEnv = {}): Promise<ReviewResult> {
  const log = new EventLog(l.events, clock);
  const gates = Gates.load();
  const matrix = Matrix.load();
  const { doc, fingerprint } = await assertScope(l, gates, log);
  const rubric = loadRubric(doc.rubric);

  const lock = readLock(l.toolchainLock);
  const containerMode = doc.network.enforcement === "container";
  // Probe for a container runtime only when this scope needs one (probing can take seconds).
  const lockedSandbox = lock.sandbox;
  const usesSandbox = (lockedSandbox !== undefined && lockedSandbox !== null) || doc.lanes.some((x) => SANDBOX_LANES.includes(x));
  const runtime = usesSandbox || containerMode ? await detectRuntime(env) : undefined;
  let problems: ToolProblems;
  let tools: Toolbox;
  let staticProblem: { outcome: "tool-missing" | "version-drift"; detail: string } | undefined;
  if (containerMode) {
    staticProblem = await imageProblem(lock, runtime);
    const sandboxLines = diffLocks(lock, { ...lock, sandbox: usesSandbox ? sandboxLockEntry(runtime) : null }).filter((x) => x.startsWith("sandbox"));
    problems = { byTool: new Map(sandboxLines.length > 0 ? [["sandbox", runtime === undefined ? "tool-missing" : "version-drift"] as const] : []), lines: sandboxLines };
    tools = staticProblem === undefined && runtime !== undefined ? containerToolbox(home, l, lock, runtime) : hostToolbox(home, l, [], runtime);
  } else {
    const checks = await doctor(home);
    problems = toolProblems(l, checks, usesSandbox ? sandboxLockEntry(runtime) : null);
    tools = hostToolbox(home, l, checks, runtime);
  }

  const runNumber = log.read().filter((e) => e.type === "run-started").length + 1;
  const runId = `R-${String(runNumber).padStart(4, "0")}`;
  const lanes = matrix.lanes.filter((id) => (doc.lanes as readonly string[]).includes(id));
  log.append("run-started", actor, { run_id: runId, fingerprint, tier: doc.tier, lanes });

  const summaries: LaneSummary[] = [];
  const drafts: FindingDraft[] = [];
  const terminal: ("continue" | "partial" | "abort")[] = [];
  let census: Readonly<Record<string, unknown>> | undefined;
  const laneMetrics: Record<string, Readonly<Record<string, unknown>>> = {};

  for (const id of lanes) {
    const lane = LANES[id];
    if (lane === undefined) throw new RefusedError(`lane "${id}" is not implemented`);
    let attempt = 1;
    for (;;) {
      try {
        await assertScope(l, gates, log); // AC9: re-checked before every attempt
      } catch (e) {
        // The scope moved under a running review: close the run as aborted, then refuse.
        log.append("run-completed", actor, { run_id: runId, status: "aborted" });
        throw e;
      }
      log.append("lane-started", actor, { run_id: runId, lane: id, attempt });
      // In container mode, an image problem affects every static lane; the sandbox has its own checks.
      const imageIssue = staticProblem !== undefined && !SANDBOX_LANES.includes(id) ? staticProblem : undefined;
      const problem = imageIssue?.outcome ?? lane.tools.map((t) => problems.byTool.get(t)).find((p) => p !== undefined);
      const result = problem !== undefined
        ? { outcome: problem, tools: [], findings: [], detail: imageIssue?.detail ?? problems.lines.join("; ") }
        : await lane.run({ layout: l, doc, runId, attempt, tools, metrics: laneMetrics });
      const resolved = matrix.resolve(id, result.outcome, attempt);
      const stored = result.metrics !== undefined && resolved.action !== "retry" ? storeMetrics(l, runId, id, result.metrics) : undefined;
      log.append("lane-completed", actor, {
        run_id: runId, lane: id, attempt, outcome: result.outcome, action: resolved.action, tools: [...result.tools],
        ...(result.detail !== undefined ? { detail: result.detail } : {}),
        ...(stored !== undefined ? { metrics_ref: stored.ref, metrics_hash: stored.hash } : {}),
      });
      if (resolved.action === "retry") {
        attempt = resolved.nextAttempt ?? attempt + 1;
        continue;
      }
      terminal.push(resolved.action);
      if (resolved.action !== "abort") drafts.push(...result.findings);
      if (result.metrics !== undefined && resolved.action !== "abort") laneMetrics[id] = result.metrics;
      if (id === "census" && result.metrics !== undefined) census = result.metrics;
      summaries.push({
        lane: id, outcome: result.outcome, action: resolved.action, attempts: attempt, findings: result.findings.length,
        ...(result.detail !== undefined ? { detail: result.detail } : {}),
      });
      break;
    }
    if (terminal.at(-1) === "abort") break;
  }

  const status = runStatus(terminal);
  if (status === "aborted") {
    log.append("run-completed", actor, { run_id: runId, status });
    return { runId, status, lanes: summaries, findings: 0, added: 0, setHash: null, ...(census !== undefined ? { census } : {}) };
  }
  let ingested;
  let notes: string[] = [];
  try {
    const pinned = readSnapshotsLock(l.snapshotsLock);
    const vulns = loadVulnContext(home, { epss: pinned.epss, kev: pinned.kev });
    if (drafts.some((d) => d.cve !== null)) notes = vulns.gaps;
    ingested = ingest(l.findings, runId, doc, rubric, drafts, vulns.ctx);
  } catch (e) {
    // e.g. the rubric refuses an unmapped (tool, severity): the run must still be closed, as aborted.
    log.append("run-completed", actor, { run_id: runId, status: "aborted" });
    throw e;
  }
  const autoConfirmed = applyAutoConfirm(log, rubric, ingested.present);
  log.append("run-completed", actor, {
    run_id: runId, status, findings_set_hash: ingested.setHash, auto_confirmed: autoConfirmed,
    ...(notes.length > 0 ? { notes } : {}),
  });
  return {
    runId, status, lanes: summaries, findings: ingested.present.length, added: ingested.added, setHash: ingested.setHash,
    autoConfirmed, notes, ...(census !== undefined ? { census } : {}),
  };
}

/** metrics/<run>/<lane>.json in canonical JSON; the event records its path and hash. */
function storeMetrics(l: Layout, runId: string, lane: string, metrics: Readonly<Record<string, unknown>>): { ref: string; hash: string } {
  const dir = path.join(l.dir, "metrics", runId);
  mkdirSync(dir, { recursive: true });
  const body = canonicalJson(metrics);
  writeFileSync(path.join(dir, `${lane}.json`), body);
  return { ref: `metrics/${runId}/${lane}.json`, hash: hashBytes(body) };
}

/** Metrics a run stored, by lane (for the scorecard and the report). */
export function readRunMetrics(l: Layout, runId: string): Record<string, Readonly<Record<string, unknown>>> {
  const dir = path.join(l.dir, "metrics", runId);
  const out: Record<string, Readonly<Record<string, unknown>>> = {};
  if (!existsSync(dir)) return out;
  for (const f of stableSort(readdirSync(dir).filter((n) => n.endsWith(".json")), (n) => n)) {
    out[f.slice(0, -".json".length)] = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as Record<string, unknown>;
  }
  return out;
}

/**
 * Rubric routing (PRD §8, M2 AC3): pending findings in the auto-confirm classes move to
 * `confirmed` with actor `rubric@<version>`. The review set never auto-confirms.
 */
function applyAutoConfirm(log: EventLog, rubric: Rubric, present: readonly Finding[]): number {
  if (rubric.routing === undefined) return 0;
  const states = dispositions(log.read());
  let n = 0;
  for (const f of stableSort(present, (x) => x.id)) {
    if (stateOf(states, f.id) !== "pending" || !autoConfirms(rubric.routing, f)) continue;
    log.append("finding-disposition", `rubric@${rubric.version}`, { finding_id: f.id, from: "pending", to: "confirmed", reason: `auto-confirm (rubric ${rubric.version} §5)` });
    n++;
  }
  return n;
}
