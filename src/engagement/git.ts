// Git invocations for the source snapshot. Host/global git config is ignored so a user's
// aliases, hooks, or fsmonitor can't change what radr sees.

import { run, type ExecResult } from "../core/exec.js";
import { RefusedError } from "../core/errors.js";

const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
};
const GIT_FLAGS = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=always"];
const GIT_TIMEOUT_MS = 30 * 60 * 1000;

export async function git(args: readonly string[], cwd: string, okExitCodes: readonly number[] = [0]): Promise<ExecResult> {
  return run({
    command: "git",
    args: [...GIT_FLAGS, ...args],
    cwd,
    inheritEnv: ["PATH", "SSH_AUTH_SOCK"],
    env: GIT_ENV,
    timeoutMs: GIT_TIMEOUT_MS,
    okExitCodes,
  });
}

/** Run git and return trimmed stdout, or throw RefusedError with git's stderr. */
export async function gitOut(args: readonly string[], cwd: string): Promise<string> {
  const r = await git(args, cwd);
  if (r.outcome !== "ok") {
    const why = r.error ?? (r.stderr.toString().trim().split("\n").at(-1) || r.outcome);
    throw new RefusedError(`git ${args[0] ?? ""}: ${why}`);
  }
  return r.stdout.toString().trim();
}
