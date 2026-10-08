// baseline.json and the diff-tier filter (PRD §13; M6 W2–W3).
//
// A baseline is the fingerprint set of one completed run: every finding it saw, whatever its
// disposition (a dismissed false positive stays suppressed too). A diff scope pins the baseline's
// hash, so editing it re-opens Gate 1. In a diff run a finding surfaces only if
//   - its fingerprint isn't in the baseline, and
//   - its file changed in base...head (the PR's own changes, as a forge shows them), or it came
//     from the secrets lane, which scans the PR's commits (base..head) and nothing else.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson, hashBytes, stableSort } from "../core/determinism.js";
import { RefusedError, UsageError } from "../core/errors.js";
import type { Layout } from "../engagement/home.js";
import { gitOut } from "../engagement/git.js";
import { readStore } from "../findings/store.js";
import type { FindingDraft } from "../findings/types.js";
import { readScopeSnapshot } from "../review/scope-snapshot.js";

export interface Baseline {
  readonly version: 1;
  readonly run_id: string;
  /** The commit the run scanned (null for runs from before scope snapshots). */
  readonly commit: string | null;
  readonly fingerprints: readonly string[];
}

export function baselineFile(l: Pick<Layout, "dir">): string {
  return path.join(l.dir, "baseline.json");
}

/** Write baseline.json from a run's findings; returns the baseline and its file hash. */
export function setBaseline(l: Layout, runId: string): { baseline: Baseline; hash: string } {
  const store = readStore(l.findings);
  const run = store.runs.find((r) => r.run_id === runId);
  if (run === undefined) throw new UsageError(`no findings recorded for ${runId} (pick a completed run: radr status)`);
  const byId = new Map(store.findings.map((f) => [f.id, f.fingerprint]));
  const fingerprints = stableSort(run.finding_ids.map((id) => byId.get(id) ?? "").filter((x) => x !== ""), (x) => x);
  const baseline: Baseline = { version: 1, run_id: runId, commit: readScopeSnapshot(l, runId)?.engagement.source.sha ?? null, fingerprints };
  const body = canonicalJson(baseline);
  writeFileSync(baselineFile(l), body);
  return { baseline, hash: hashBytes(body) };
}

/** The pinned baseline, verified against the hash the scope fingerprint froze. */
export function readBaseline(l: Layout, expectedHash: string): Baseline {
  const f = baselineFile(l);
  if (!existsSync(f)) throw new RefusedError("baseline.json is missing (radr baseline set --from <R-id>, then re-scope)");
  const bytes = readFileSync(f);
  if (hashBytes(bytes) !== expectedHash) throw new RefusedError("baseline.json changed after the scope was approved; re-scope and approve");
  return JSON.parse(bytes.toString("utf8")) as Baseline;
}

/** Files changed in base...head (merge-base to head), repo-relative POSIX paths. */
export async function changedFiles(mirror: string, base: string, head: string): Promise<Set<string>> {
  const out = await gitOut(["diff", "--name-only", "--no-renames", "--no-color", `${base}...${head}`], mirror);
  return new Set(out === "" ? [] : out.split("\n"));
}

/** The diff-tier filter for ingest: true = the finding surfaces. */
export function diffFilter(baseline: Baseline, changed: ReadonlySet<string>): (fingerprint: string, d: FindingDraft) => boolean {
  const known = new Set(baseline.fingerprints);
  return (fingerprint, d) => !known.has(fingerprint) && (d.lane === "secrets" || changed.has(d.file));
}
