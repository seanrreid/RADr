// Build sandbox (PRD §14.1a, M2 AC7): a throwaway container per lane run, built from a pinned
// base image, that runs CLIENT CODE (installs, builds, tests). Isolation, fail-closed:
//   - non-root (podman --userns=keep-id / docker --user uid:gid)
//   - --network=none unless the scope's network mode is `network` (or `deps warm`)
//   - source mounted read-only and copied into the container's own scratch space
//   - all capabilities dropped, no-new-privileges, pids/memory/cpu limits
//   - --pull=never: images are pulled only by `radr tools install`, never mid-run
//   - a named container that is killed on timeout

import { realpathSync } from "node:fs";
import { readAsset } from "../core/assets.js";
import { InternalError, RefusedError } from "../core/errors.js";
import { run, type ExecResult } from "../core/exec.js";
import { parseYaml } from "../core/yaml.js";
import { makeValidator } from "../schemas/validate.js";

export type RuntimeName = "podman" | "docker";

export interface Runtime {
  readonly name: RuntimeName;
  /** Server version string, recorded in toolchain.lock. */
  readonly version: string;
}

/** Host env a container CLI needs to reach its machine/daemon. Nothing else is passed. */
const RUNTIME_ENV = ["PATH", "HOME", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "CONTAINER_HOST", "CONTAINER_CONNECTION", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"];
const PROBE_TIMEOUT_MS = 20_000;

export async function detectRuntime(env: NodeJS.ProcessEnv): Promise<Runtime | undefined> {
  const forced = env["RADR_CONTAINER_RUNTIME"];
  if (forced === "none") return undefined;
  const order: RuntimeName[] = forced === "podman" || forced === "docker" ? [forced] : ["podman", "docker"];
  for (const name of order) {
    const format = name === "podman" ? "{{.Version.Version}}" : "{{.ServerVersion}}";
    const r = await run({ command: name, args: ["info", "--format", format], cwd: "/", inheritEnv: RUNTIME_ENV, timeoutMs: PROBE_TIMEOUT_MS });
    const version = r.stdout.toString().trim();
    if (r.outcome === "ok" && version !== "") return { name, version };
  }
  if (forced === "podman" || forced === "docker") throw new RefusedError(`RADR_CONTAINER_RUNTIME=${forced}, but it isn't reachable (is the machine/daemon running?)`);
  return undefined;
}

export interface SandboxImages {
  readonly version: 1;
  readonly images: Readonly<Record<string, { readonly ref: string; readonly tag: string; readonly purpose: string; readonly platforms: readonly string[] }>>;
}

const validateImages = makeValidator<SandboxImages>(
  {
    type: "object", additionalProperties: false, required: ["version", "images"],
    properties: {
      version: { const: 1 },
      images: { type: "object", additionalProperties: {
        type: "object", additionalProperties: false, required: ["ref", "tag", "purpose", "platforms"],
        properties: {
          ref: { type: "string", pattern: "^(docker\\.io|mcr\\.microsoft\\.com)/[a-z0-9/._-]+@sha256:[0-9a-f]{64}$" },
          tag: { type: "string" }, purpose: { type: "string" }, platforms: { type: "array", items: { type: "string" } },
        },
      } },
    },
  },
  InternalError,
);

export function loadSandboxImages(): SandboxImages {
  return validateImages(parseYaml(readAsset("toolchain/sandbox-images.yml"), "toolchain/sandbox-images.yml"), "toolchain/sandbox-images.yml");
}

export function imageRef(name: string): string {
  const img = loadSandboxImages().images[name];
  if (img === undefined) throw new InternalError(`no pinned sandbox image "${name}"`);
  return img.ref;
}

/** Pull pinned images (network). Called by `radr tools install` when a runtime exists. */
/** Images every install pulls; stack bases are pulled on demand (`radr deps warm`, `build-image --stack`). */
export const DEFAULT_PULL: readonly string[] = ["node", "python"];

export async function pullImages(rt: Runtime): Promise<Record<string, "pulled" | "present">> {
  const out: Record<string, "pulled" | "present"> = {};
  for (const [name, img] of Object.entries(loadSandboxImages().images)) {
    if (!DEFAULT_PULL.includes(name)) continue;
    const exists = await run({ command: rt.name, args: ["image", "inspect", "--format", "{{.Id}}", img.ref], cwd: "/", inheritEnv: RUNTIME_ENV });
    if (exists.outcome === "ok") {
      out[name] = "present";
      continue;
    }
    const r = await run({ command: rt.name, args: ["pull", "--quiet", img.ref], cwd: "/", inheritEnv: RUNTIME_ENV, timeoutMs: 15 * 60 * 1000 });
    if (r.outcome !== "ok") throw new RefusedError(`pulling ${img.ref} failed: ${r.stderr.toString().trim().split("\n").at(-1) ?? r.outcome}`);
    out[name] = "pulled";
  }
  return out;
}

export interface Mount {
  readonly host: string;
  readonly container: string;
  readonly readOnly: boolean;
}

export interface SandboxStep {
  readonly name: string;
  /** Shell command run inside the container (this is where client code executes). */
  readonly command: string;
  /** A failed required step stops the remaining steps. */
  readonly required: boolean;
}

export interface SandboxRequest {
  readonly runtime: Runtime;
  readonly image: string;
  /** Unique container name (radr-<run>-<lane>-<n>), used to kill it on timeout. */
  readonly name: string;
  readonly network: boolean;
  readonly mounts: readonly Mount[];
  /** Directory under /tmp/work (the copied source) to run steps in. */
  readonly workdir: string;
  readonly steps: readonly SandboxStep[];
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly memory?: string;
  readonly cpus?: string;
}

export interface StepResult {
  readonly name: string;
  readonly exitCode: number;
}

export interface SandboxResult {
  readonly exec: ExecResult;
  /** Per-step exit codes, in order, for the steps that ran. */
  readonly steps: readonly StepResult[];
}

const SAFE_NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const SAFE_WORKDIR = /^[A-Za-z0-9._/-]*$/;

/** Build the in-container script: copy source, run steps, record each exit code to /radr/out/steps.txt. */
export function sandboxScript(workdir: string, steps: readonly SandboxStep[]): string {
  if (!SAFE_WORKDIR.test(workdir) || workdir.split("/").includes("..")) throw new RefusedError(`unsafe sandbox workdir "${workdir}"`);
  const lines = [
    "set -u",
    "mkdir -p /tmp/home /radr/out",
    ": > /radr/out/steps.txt",
    // radr keeps the worktree read-only, and cp preserves modes: make the SCRATCH copy writable
    // (the /src mount itself stays read-only).
    "cp -R /src /tmp/work && chmod -R u+w /tmp/work",
    `cd "/tmp/work/${workdir}" || { echo "workdir missing" >&2; exit 97; }`,
  ];
  for (const s of steps) {
    if (!SAFE_NAME.test(s.name)) throw new RefusedError(`unsafe step name "${s.name}"`);
    lines.push(`( ${s.command} ) > "/radr/out/${s.name}.log" 2>&1; rc=$?; echo "${s.name} $rc" >> /radr/out/steps.txt`);
    if (s.required) lines.push(`[ "$rc" -eq 0 ] || exit 0`);
  }
  lines.push("exit 0");
  return lines.join("\n");
}

export function parseSteps(text: string): StepResult[] {
  return text.split("\n").filter((l) => l.trim() !== "").map((l) => {
    const [name, code] = l.trim().split(" ");
    const exitCode = Number.parseInt(code ?? "", 10);
    if (name === undefined || !Number.isInteger(exitCode)) throw new RefusedError(`malformed sandbox step record "${l}"`);
    return { name, exitCode };
  });
}

/** Arguments for `<runtime> run`. Exported for tests: isolation flags must never regress. */
export function sandboxArgs(req: SandboxRequest, uid: number, gid: number): string[] {
  if (!SAFE_NAME.test(req.name)) throw new RefusedError(`unsafe container name "${req.name}"`);
  const args = [
    "run", "--rm", "--pull=never", "--name", req.name,
    `--network=${req.network ? "bridge" : "none"}`,
    "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=2048",
    `--memory=${req.memory ?? "4g"}`, `--cpus=${req.cpus ?? "2"}`,
    ...(req.runtime.name === "podman" ? ["--userns=keep-id", `--user=${String(uid)}:${String(gid)}`] : [`--user=${String(uid)}:${String(gid)}`]),
    "-e", "HOME=/tmp/home", "-e", "CI=1", "-e", "TZ=UTC", "-e", "LC_ALL=C.UTF-8", "-e", "LANG=C.UTF-8",
    "-e", "npm_config_update_notifier=false", "-e", "PIP_DISABLE_PIP_VERSION_CHECK=1", "-e", "PYTHONDONTWRITEBYTECODE=1",
  ];
  for (const [k, v] of Object.entries(req.env ?? {})) args.push("-e", `${k}=${v}`);
  for (const m of req.mounts) args.push("-v", `${realpathSync(m.host)}:${m.container}:${m.readOnly ? "ro" : "rw"}`);
  args.push("-w", "/tmp", req.image, "sh", "-c", sandboxScript(req.workdir, req.steps));
  return args;
}

export async function runSandbox(req: SandboxRequest, outDir: string): Promise<SandboxResult> {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const r = await run({
    command: req.runtime.name, args: sandboxArgs(req, uid, gid), cwd: "/", inheritEnv: RUNTIME_ENV,
    timeoutMs: req.timeoutMs, okExitCodes: [0],
  });
  if (r.outcome === "timeout") {
    await run({ command: req.runtime.name, args: ["kill", req.name], cwd: "/", inheritEnv: RUNTIME_ENV, okExitCodes: [0, 1, 125] });
  }
  let steps: StepResult[] = [];
  try {
    const { readFileSync } = await import("node:fs");
    steps = parseSteps(readFileSync(`${outDir}/steps.txt`, "utf8"));
  } catch (e) {
    if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) throw e;
  }
  return { exec: r, steps };
}

/** The toolchain.lock entry for a runtime: what the scope fingerprint pins about the sandbox. */
export function sandboxLockEntry(rt: Runtime | undefined, stackImages: Readonly<Record<string, string>> = {}): { runtime: string; version: string; images: Record<string, string> } | null {
  if (rt === undefined) return null;
  // Stack images (M3 W5) are content-addressed tags: a pin change shows up here as drift.
  const images: Record<string, string> = Object.fromEntries(Object.entries(stackImages).map(([k, v]) => [`stack:${k}`, v]));
  for (const [name, img] of Object.entries(loadSandboxImages().images)) images[name] = img.ref;
  return { runtime: rt.name, version: rt.version, images };
}
