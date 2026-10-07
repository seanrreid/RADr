// Who is acting. Gate and disposition events require an identity; there is no anonymous default.

import { RefusedError } from "./errors.js";
import { run } from "./exec.js";

const ACTOR_PATTERN = /^[^\s@]+@[^\s@]+$|^[a-z0-9][a-z0-9._-]{0,63}$/i;

export async function resolveActor(env: NodeJS.ProcessEnv): Promise<string> {
  const configured = env["RADR_ACTOR"];
  const candidate = configured !== undefined && configured !== "" ? configured : await gitEmail(env);
  if (candidate === undefined || candidate === "") {
    throw new RefusedError("no actor identity: set RADR_ACTOR or `git config --global user.email`");
  }
  if (!ACTOR_PATTERN.test(candidate)) throw new RefusedError(`invalid actor identity "${candidate}"`);
  return candidate;
}

/** Reads global git config using the CALLER's env (not process.env), so injected envs are honored. */
async function gitEmail(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const pass: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "XDG_CONFIG_HOME"]) {
    const v = env[name];
    if (v !== undefined) pass[name] = v;
  }
  if (pass["HOME"] === undefined) return undefined;
  const r = await run({ command: "git", args: ["config", "--global", "user.email"], cwd: pass["HOME"], env: pass });
  return r.outcome === "ok" ? r.stdout.toString().trim() : undefined;
}
