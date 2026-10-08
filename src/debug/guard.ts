// Regression guard (PRD §11 step 6; M5 W4): the repro turned into a test that FAILS without the
// fix and PASSES with it, both runs recorded. The consultant supplies:
//   guard/test.patch   the test (the deliverable: a patch file for the client)
//   guard/guard.sh     how to run it (same contract as the repro: 0 = passes / bug absent)
//   guard/fix.patch    the fix, unless --fix-commit names a commit that contains it
// radr never writes the fix (decided with Sean 2026-10-08). Patches are applied with git on the
// host, into a temporary checkout that is then made read-only and mounted like any worktree.

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { hashBytes } from "../core/determinism.js";
import { RefusedError, UsageError } from "../core/errors.js";
import type { Layout } from "../engagement/home.js";
import { git, gitOut } from "../engagement/git.js";
import { checkoutWorktree, setWritable } from "../engagement/source.js";
import type { EventLog } from "../state/events.js";
import { runDebugScript, type DebugSandbox, type RunResult } from "./sandbox.js";
import { reproducing, type DebugState } from "./state.js";

export interface GuardResult {
  readonly withoutFix: RunResult;
  readonly withFix: RunResult;
  readonly holds: boolean;
}

/** A read-only checkout of `sha` with `patches` applied, for the duration of `fn`. */
async function patchedCheckout<T>(l: Layout, label: string, sha: string, patches: readonly string[], fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = path.join(l.cache, "debug-worktrees", `${label}-${sha}`);
  mkdirSync(path.dirname(dir), { recursive: true });
  await checkoutWorktree(l.mirror, dir, sha);
  setWritable(dir, true);
  try {
    for (const p of patches) {
      const r = await git(["apply", "--whitespace=nowarn", "--", p], dir, [0, 1]);
      if (r.exitCode !== 0) throw new RefusedError(`${path.basename(p)} does not apply at ${sha.slice(0, 12)}: ${r.stderr.toString().trim().split("\n")[0] ?? ""}`);
    }
    setWritable(dir, false);
    return await fn(dir);
  } finally {
    setWritable(dir, true);
    await git(["worktree", "remove", "--force", dir], l.mirror, [0, 128]);
    rmSync(dir, { recursive: true, force: true });
    await gitOut(["worktree", "prune"], l.mirror);
  }
}

export async function guard(l: Layout, log: EventLog, actor: string, sb: DebugSandbox, d: DebugState, guardDir: string, fixCommit: string | undefined): Promise<GuardResult> {
  if (d.conclusion?.outcome === "cannot-reproduce") throw new RefusedError(`${d.id} concluded cannot-reproduce: there's no bug to guard`);
  if (reproducing(d).length === 0) throw new RefusedError(`${d.id} hasn't been reproduced: a regression guard turns a reproduced bug into a test`);
  const testPatch = path.join(guardDir, "test.patch");
  const script = path.join(guardDir, "guard.sh");
  const fixPatch = path.join(guardDir, "fix.patch");
  for (const f of [testPatch, script]) if (!existsSync(f)) throw new UsageError(`${f} not found (the guard needs test.patch and guard.sh)`);
  if (fixCommit === undefined && !existsSync(fixPatch)) throw new UsageError(`${fixPatch} not found: supply the fix as a patch, or name a commit with --fix-commit`);
  const h = (f: string) => hashBytes(readFileSync(f));

  const withoutFix = await patchedCheckout(l, "guard-without", d.commit, [testPatch], (worktree) =>
    runDebugScript(l, log, actor, sb, { debugId: d.id, kind: "guard-without-fix", commit: d.commit, worktree, script, patchHashes: [h(testPatch)] }));
  const fixedAt = fixCommit ?? d.commit;
  const fixPatches = fixCommit === undefined ? [testPatch, fixPatch] : [testPatch];
  const withFix = await patchedCheckout(l, "guard-with", fixedAt, fixPatches, (worktree) =>
    runDebugScript(l, log, actor, sb, { debugId: d.id, kind: "guard-with-fix", commit: fixedAt, worktree, script, patchHashes: fixPatches.map(h) }));
  return { withoutFix, withFix, holds: withoutFix.outcome === "present" && withFix.outcome === "absent" };
}
