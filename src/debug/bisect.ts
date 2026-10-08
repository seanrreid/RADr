// Bisect (PRD §11 step 3; M5 W2). radr drives it, not `git bisect run` in the container: the
// source mount is read-only and the images carry no git. radr lists the commits between a known
// good and the debug's (reproduced) bad commit, checks each candidate out of its own mirror into
// a temporary read-only worktree, and runs the frozen repro there in a fresh sandbox.
//
// It is a binary search over a fixed, ordered list, so given the same results it tests the same
// commits. A skipped commit (its install fails offline, or the repro exits 125) is stepped
// around; if skips leave more than one candidate, the result is that range, never a guess.

import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { RefusedError } from "../core/errors.js";
import type { Layout } from "../engagement/home.js";
import { git, gitOut } from "../engagement/git.js";
import { checkoutWorktree, resolveSha, setWritable } from "../engagement/source.js";
import type { EventLog } from "../state/events.js";
import { runDebugScript, scriptHash, type DebugSandbox, type RunResult } from "./sandbox.js";
import { assertOpen, reproducing, type DebugState } from "./state.js";

/** At most this many candidate commits (about 9 sandbox runs); decided with Sean 2026-10-08. */
export const MAX_CANDIDATES = 512;

export interface BisectResult {
  readonly good: string;
  readonly bad: string;
  /** The first bad commit, or the candidates it must be one of when commits were skipped. */
  readonly firstBad: readonly string[];
  readonly runs: readonly RunResult[];
}

/** Next index to test in (lo, hi): the midpoint, else the nearest untested, unskipped index. */
export function nextProbe(lo: number, hi: number, skipped: ReadonlySet<number>): number | undefined {
  const mid = Math.floor((lo + hi) / 2);
  for (let off = 0; off < hi - lo; off++) {
    for (const i of off === 0 ? [mid] : [mid + off, mid - off]) {
      if (i > lo && i < hi && !skipped.has(i)) return i;
    }
  }
  return undefined;
}

async function atCommit<T>(l: Layout, sha: string, fn: (worktree: string) => Promise<T>): Promise<T> {
  const dir = path.join(l.cache, "debug-worktrees", sha);
  mkdirSync(path.dirname(dir), { recursive: true });
  await checkoutWorktree(l.mirror, dir, sha);
  try {
    return await fn(dir);
  } finally {
    setWritable(dir, true);
    await git(["worktree", "remove", "--force", dir], l.mirror, [0, 128]);
    rmSync(dir, { recursive: true, force: true });
    await gitOut(["worktree", "prune"], l.mirror);
  }
}

export async function bisect(l: Layout, log: EventLog, actor: string, sb: DebugSandbox, d: DebugState, goodRev: string, script: string): Promise<BisectResult> {
  assertOpen(d);
  const reproduced = reproducing(d)[0];
  if (reproduced === undefined) throw new RefusedError(`${d.id} hasn't been reproduced yet: bisect needs a repro that shows the bug at ${d.commit.slice(0, 12)} (radr debug repro)`);
  if (scriptHash(script) !== reproduced.scriptHash) throw new RefusedError(`repro.sh changed after it reproduced the bug (${reproduced.runId}); bisect only runs the repro that reproduced`);
  const good = await resolveSha(l.mirror, goodRev);
  const bad = d.commit;
  if (good === bad) throw new RefusedError("the good commit is the bad commit");
  const ancestor = await git(["merge-base", "--is-ancestor", good, bad], l.mirror, [0, 1]);
  if (ancestor.exitCode !== 0) throw new RefusedError(`${good.slice(0, 12)} is not an ancestor of ${bad.slice(0, 12)}; give a known-good commit from the bad commit's history`);
  const listed = await gitOut(["rev-list", "--first-parent", "--reverse", `${good}..${bad}`], l.mirror);
  const candidates = listed === "" ? [] : listed.split("\n");
  if (candidates.length > MAX_CANDIDATES) {
    throw new RefusedError(`${String(candidates.length)} commits between good and bad (cap ${String(MAX_CANDIDATES)}); give a closer known-good commit`);
  }
  if (candidates.at(-1) !== bad) throw new RefusedError(`the bad commit isn't on the first-parent line from ${good.slice(0, 12)}`);

  const runs: RunResult[] = [];
  const probe = async (sha: string): Promise<RunResult> => {
    const r = await atCommit(l, sha, (worktree) => runDebugScript(l, log, actor, sb, { debugId: d.id, kind: "bisect", commit: sha, worktree, script }));
    runs.push(r);
    if (r.outcome === "error") throw new RefusedError(`bisect stopped: the sandbox failed at ${sha.slice(0, 12)} (${r.runId}, ${r.logRef})`);
    return r;
  };

  // The good end must really be good, or the search means nothing.
  const g = await probe(good);
  if (g.outcome === "present") throw new RefusedError(`the bug is present at the "good" commit ${good.slice(0, 12)} (${g.runId}); give an older known-good commit`);
  if (g.outcome === "skip") throw new RefusedError(`can't tell at the good commit ${good.slice(0, 12)} (${g.runId}); give a known-good commit that installs`);

  // Invariant: index lo is good (-1 = `good`), index hi is bad (the last candidate = `bad`).
  let lo = -1;
  let hi = candidates.length - 1;
  const skipped = new Set<number>();
  for (let i = nextProbe(lo, hi, skipped); i !== undefined; i = nextProbe(lo, hi, skipped)) {
    const r = await probe(candidates[i] ?? "");
    if (r.outcome === "present") hi = i;
    else if (r.outcome === "absent") lo = i;
    else skipped.add(i);
  }
  const firstBad = candidates.slice(lo + 1, hi + 1);
  log.append("debug-bisected", actor, { debug_id: d.id, good, bad, first_bad: firstBad, runs: runs.map((r) => r.runId) });
  return { good, bad, firstBad, runs };
}
