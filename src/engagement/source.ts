// Source snapshot (PRD §8, T2.2): radr's own mirror clone of the client fork, and a read-only
// checkout of the approved SHA that lanes scan. The consultant's working copy is never read
// directly, so its uncommitted changes or branch switches can't leak into a run.

import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { hash } from "../core/determinism.js";
import { RefusedError, UsageError } from "../core/errors.js";
import { git, gitOut } from "./git.js";

const SHA_RE = /^[0-9a-f]{40}$/;

export async function mirrorSource(origin: string, mirrorDir: string): Promise<void> {
  if (origin.startsWith("-")) throw new UsageError(`invalid source "${origin}"`);
  if (existsSync(mirrorDir)) throw new RefusedError(`source mirror already exists at ${mirrorDir}; use \`radr source fetch\``);
  mkdirSync(path.dirname(mirrorDir), { recursive: true, mode: 0o700 });
  await gitOut(["clone", "--mirror", "--no-hardlinks", "--", origin, mirrorDir], path.dirname(mirrorDir));
  if ((await gitOut(["rev-parse", "--is-shallow-repository"], mirrorDir)) === "true") {
    throw new RefusedError(`source ${origin} is a shallow clone; full history is required for the secrets and history lanes`);
  }
}

export async function fetchSource(mirrorDir: string): Promise<void> {
  await gitOut(["remote", "update", "--prune"], mirrorDir);
}

/** Stable hash of every ref in the mirror (name + target), for source-mirrored/fetched events. */
export async function refsHash(mirrorDir: string): Promise<{ hash: string; refs: string[] }> {
  const out = await gitOut(["for-each-ref", "--format=%(objectname) %(refname)"], mirrorDir);
  const refs = out === "" ? [] : out.split("\n");
  return { hash: hash(refs), refs: refs.map((r) => r.split(" ")[1] ?? r) };
}

/** Resolve a commit-ish (or the mirror's HEAD) to a full SHA that exists in the mirror. */
export async function resolveSha(mirrorDir: string, rev: string | undefined): Promise<string> {
  if (rev?.startsWith("-") === true) throw new UsageError(`invalid revision "${rev}"`);
  const sha = await gitOut(["rev-parse", "--verify", "--end-of-options", `${rev ?? "HEAD"}^{commit}`], mirrorDir);
  if (!SHA_RE.test(sha)) throw new RefusedError(`could not resolve "${rev ?? "HEAD"}" to a commit`);
  return sha;
}

/** (Re)create the read-only worktree at `sha`. */
export async function checkoutWorktree(mirrorDir: string, worktreeDir: string, sha: string): Promise<void> {
  if (existsSync(worktreeDir)) {
    setWritable(worktreeDir, true);
    await git(["worktree", "remove", "--force", worktreeDir], mirrorDir, [0, 128]);
    rmSync(worktreeDir, { recursive: true, force: true });
    await gitOut(["worktree", "prune"], mirrorDir);
  }
  await gitOut(["worktree", "add", "--detach", "--force", worktreeDir, sha], mirrorDir);
  setWritable(worktreeDir, false);
}

/**
 * AC9: before every lane, the worktree must be at the approved SHA with no modified, deleted,
 * or untracked files.
 */
export async function verifyWorktree(worktreeDir: string, sha: string): Promise<void> {
  if (!existsSync(worktreeDir)) throw new RefusedError(`source worktree missing at ${worktreeDir} (run \`radr scope\`)`);
  const head = await gitOut(["rev-parse", "HEAD"], worktreeDir);
  if (head !== sha) throw new RefusedError(`source worktree is at ${head}, but scope is approved for ${sha}`);
  const status = await gitOut(["status", "--porcelain=v1", "--untracked-files=all", "--ignored=no"], worktreeDir);
  if (status !== "") throw new RefusedError(`source worktree has changes (${status.split("\n").length} paths); it must match ${sha} exactly`);
}

/** Recursively add or remove write permission (owner/group/other) on a tree. Symlinks untouched. */
export function setWritable(root: string, writable: boolean): void {
  const walk = (p: string): void => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory() && writable) chmodSync(p, st.mode | 0o200);
    if (st.isDirectory()) for (const name of readdirSync(p)) walk(path.join(p, name));
    chmodSync(p, writable ? st.mode | 0o200 : st.mode & ~0o222);
  };
  if (existsSync(root)) walk(root);
}
