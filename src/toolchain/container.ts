// Container execution of static lanes (M3 W0, AC2). Every tool invocation runs in the locally
// built toolchain image with --network=none: "offline" is ENFORCED, not declared.
//
// Same-path mounts: host paths are mounted at their own absolute paths (plus any symlinked
// alias, e.g. macOS /var → /private/var), so tools report exactly the paths they would on the
// host and adapters/fingerprints don't depend on the mode (AC3).

import { realpathSync } from "node:fs";
import { RefusedError } from "../core/errors.js";
import { buildEnv, run, type ExecRequest, type ExecResult } from "../core/exec.js";
import type { Runtime } from "../sandbox/runtime.js";

export interface ContainerMount {
  readonly path: string;
  readonly readOnly: boolean;
}

/** Same-path volume flags for a mount, covering a symlinked alias of the path too. */
export function volumeFlags(mounts: readonly ContainerMount[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of mounts) {
    const real = realpathSync(m.path);
    for (const target of [real, m.path]) {
      if (seen.has(target)) continue;
      seen.add(target);
      out.push("-v", `${real}:${target}:${m.readOnly ? "ro" : "rw"}`);
    }
  }
  return out;
}

const RUNTIME_ENV = ["PATH", "HOME", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "CONTAINER_HOST", "CONTAINER_CONNECTION", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"];

/** `<runtime> run` arguments for one tool invocation. Exported for tests: isolation must not regress. */
export function toolContainerArgs(rt: Runtime, image: string, req: ExecRequest, mounts: readonly ContainerMount[], uid: number, gid: number): string[] {
  // The image's own PATH is authoritative inside the container; host PATH is never passed.
  const env = buildEnv({ ...(req.env !== undefined ? { env: req.env } : {}) }, {});
  delete env["PATH"];
  const args = [
    "run", "--rm", "--pull=never", "--network=none", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--pids-limit=2048", "--memory=4g",
    ...(rt.name === "podman" ? ["--userns=keep-id"] : []), `--user=${String(uid)}:${String(gid)}`,
  ];
  for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
  args.push(...volumeFlags(mounts), "-w", req.cwd, image, req.command, ...req.args);
  return args;
}

export type Exec = (req: ExecRequest) => Promise<ExecResult>;

export function hostExec(): Exec {
  return run;
}

/** Exec that runs each request in the toolchain image. Mounts are fixed per run (the engagement). */
export function containerExec(rt: Runtime, image: string, mounts: readonly ContainerMount[]): Exec {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  return async (req) => {
    const r = await run({
      command: rt.name, args: toolContainerArgs(rt, image, req, mounts, uid, gid), cwd: "/", inheritEnv: RUNTIME_ENV,
      ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
      ...(req.maxOutputBytes !== undefined ? { maxOutputBytes: req.maxOutputBytes } : {}),
      ...(req.okExitCodes !== undefined ? { okExitCodes: req.okExitCodes } : {}),
    });
    // podman/docker exit 125–127 for their OWN failures (no image, bad mount, missing binary).
    if (r.outcome === "nonzero-exit" && (r.exitCode === 125 || r.exitCode === 126 || r.exitCode === 127)) {
      const why = r.stderr.toString().trim().split("\n").at(-1) ?? "";
      if (/image not known|no such image|not found|executable file not found/i.test(why)) return { ...r, outcome: "tool-missing", error: why };
      return { ...r, outcome: "spawn-error", error: why };
    }
    return r;
  };
}

export function assertSafeImage(ref: string): string {
  if (!/^localhost\/radr-toolchain:[0-9a-f]{16}$/.test(ref)) throw new RefusedError(`unexpected toolchain image reference "${ref}"`);
  return ref;
}
