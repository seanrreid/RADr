// `radr verify --against R-NNNN` (PRD §7 VERIFY, §8; M6 W0): re-run the approved lanes on the
// client's fixed commit, then move each finding of R-NNNN through the disposition machine:
//
//   confirmed, absent                     → fixed, and → verified if its lane ran clean
//   fixed, absent, lane ran clean         → verified
//   fixed | verified, present again       → regressed (the consultant re-confirms it)
//   pending | dismissed | waived          → untouched
//
// "Ran clean" = the lane's final outcome in the verify run was `success`: a partial lane can't
// vouch that something is gone. Identity is the finding fingerprint (stable across code moving
// around). Findings without a snippet fall back to their line number, so a moved one would look
// fixed; when the verify run has a same-tool, same-rule, same-file, same-message finding, the
// absent one is listed for a manual check instead of being marked fixed.
//
// The verify scope must equal R-NNNN's in everything but the commit and the dependency-cache
// snapshot (a fixed lockfile needs a fresh `radr deps warm`): otherwise the comparison is
// meaningless, and verify refuses before running anything.

import type { Clock } from "../core/clock.js";
import { canonicalJson } from "../core/determinism.js";
import { RefusedError } from "../core/errors.js";
import type { Layout } from "../engagement/home.js";
import { canTransition, dispositions, stateOf, type DispositionState } from "../findings/disposition.js";
import { readStore } from "../findings/store.js";
import type { Finding } from "../findings/types.js";
import { readScopeInputs } from "../state/fingerprint.js";
import { readScopeSnapshot, review, type ReviewResult, type ScopeSnapshot } from "../review/run.js";
import { parseYaml } from "../core/yaml.js";
import { existsSync, readFileSync } from "node:fs";
import { EventLog } from "../state/events.js";

export interface VerifyResult {
  readonly against: string;
  readonly run: ReviewResult;
  readonly fixed: readonly string[];
  readonly verified: readonly string[];
  readonly regressed: readonly string[];
  readonly stillPresent: readonly string[];
  /** Absent findings that may have moved (no snippet), and judgment findings: a person checks. */
  readonly manual: readonly string[];
}

/** Why the current scope can't verify `against`'s run, or null when only commit/deps differ. */
export function scopeDifference(before: ScopeSnapshot, now: ScopeSnapshot): string | null {
  const strip = (s: ScopeSnapshot) => {
    const { source, ...doc } = s.engagement;
    const snaps = (s.snapshots_lock ?? {}) as Record<string, unknown>;
    const { deps: _deps, ...pinned } = snaps;
    return { origin: source.origin, doc, toolchain: s.toolchain_lock, snapshots: pinned };
  };
  const a = strip(before);
  const b = strip(now);
  const differs = (["origin", "doc", "toolchain", "snapshots"] as const).filter((k) => canonicalJson(a[k] ?? null) !== canonicalJson(b[k] ?? null));
  if (differs.length > 0) {
    const names: Record<string, string> = { origin: "the source origin", doc: "engagement.yml (other than the commit)", toolchain: "toolchain.lock", snapshots: "the vulnerability snapshots" };
    return `the scope changed beyond the commit: ${differs.map((k) => names[k]).join(", ")}`;
  }
  if (before.engagement.source.sha === now.engagement.source.sha) return "the approved scope is at the same commit as the run being verified; scope the fixed commit (radr scope --rev <sha>) and approve it";
  return null;
}

function currentSnapshot(l: Layout): ScopeSnapshot {
  const inputs = readScopeInputs(l);
  const read = (f: string): unknown => (existsSync(f) ? parseYaml(readFileSync(f, "utf8"), f) : null);
  return { engagement: inputs.engagement, toolchain_lock: read(l.toolchainLock), snapshots_lock: read(l.snapshotsLock) };
}

/** Finding ids a run observed. */
function runIds(l: Layout, runId: string): Set<string> {
  const r = readStore(l.findings).runs.find((x) => x.run_id === runId);
  if (r === undefined) throw new RefusedError(`no findings recorded for ${runId} (was it aborted?)`);
  return new Set(r.finding_ids);
}

export async function verify(home: string, l: Layout, against: string, actor: string, clock: Clock, env: NodeJS.ProcessEnv): Promise<VerifyResult> {
  const before = readScopeSnapshot(l, against);
  if (before === null) throw new RefusedError(`${against} has no scope snapshot (raw/${against}/scope.json): it predates radr verify; re-run the review at the original commit, then verify against that run`);
  const why = scopeDifference(before, currentSnapshot(l));
  if (why !== null) throw new RefusedError(`can't verify against ${against}: ${why}`);
  const oldIds = runIds(l, against);

  const run = await review(home, l, actor, clock, env);
  if (run.status === "aborted") throw new RefusedError(`the verify run ${run.runId} was aborted; nothing was marked`);
  const newIds = runIds(l, run.runId);
  const findings = new Map(readStore(l.findings).findings.map((f) => [f.id, f]));
  const log = new EventLog(l.events, clock);
  const events = log.read();
  const states = dispositions(events);
  const cleanLanes = new Set(events
    .filter((e) => e.type === "lane-completed" && e.data["run_id"] === run.runId && e.data["action"] !== "retry" && e.data["outcome"] === "success")
    .map((e) => String(e.data["lane"])));
  // Possible moves: a no-snippet finding of the old run vs. a new one with the same identity text.
  const moveKey = (f: Finding) => canonicalJson([f.tool, f.rule_id, f.file, f.message]);
  const newNoSnippet = new Set([...newIds].map((id) => findings.get(id)).filter((f): f is Finding => f !== undefined && f.snippet === null && !oldIds.has(f.id)).map(moveKey));

  const verifier = `verify@${run.runId}`;
  const sha = currentSnapshot(l).engagement.source.sha;
  const move = (id: string, from: DispositionState, to: DispositionState, reason: string): DispositionState => {
    if (!canTransition(from, to)) throw new RefusedError(`internal: verify tried ${from} → ${to} for ${id}`);
    log.append("finding-disposition", verifier, { finding_id: id, from, to, reason });
    return to;
  };
  const out = { fixed: [] as string[], verified: [] as string[], regressed: [] as string[], stillPresent: [] as string[], manual: [] as string[] };

  // Every finding the old run saw, plus any earlier fixed/verified one this run sees again.
  const candidates = new Set([...oldIds, ...[...newIds].filter((id) => ["fixed", "verified"].includes(stateOf(states, id)))]);
  for (const id of [...candidates].sort()) {
    const f = findings.get(id);
    if (f === undefined) continue;
    let state = stateOf(states, id);
    const present = newIds.has(id);
    if (present) {
      if (state === "fixed" || state === "verified") {
        move(id, state, "regressed", `present again at ${sha.slice(0, 12)} in ${run.runId}`);
        out.regressed.push(id);
      } else if (state === "confirmed") out.stillPresent.push(id);
      continue;
    }
    if (state !== "confirmed" && state !== "fixed") continue;
    if (f.snippet === null && newNoSnippet.has(moveKey(f))) {
      out.manual.push(id);
      continue;
    }
    if (state === "confirmed") {
      state = move(id, state, "fixed", `absent at ${sha.slice(0, 12)} in ${run.runId}`);
      out.fixed.push(id);
    }
    if (cleanLanes.has(f.lane)) {
      move(id, state, "verified", `absent at ${sha.slice(0, 12)} and lane ${f.lane} ran clean in ${run.runId}`);
      out.verified.push(id);
    }
  }
  log.append("verify-completed", actor, {
    against, run_id: run.runId, commit: sha, fixed: out.fixed.length, verified: out.verified.length, regressed: out.regressed.length,
    still_present: out.stillPresent.length, manual: out.manual,
  });
  return { against, run, ...out };
}
