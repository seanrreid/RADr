// Everything Address-phase code (scorecard, report, remediation plan) reads about the latest
// run, gathered in one place so every view is derived from the same snapshot of state.

import type { Clock } from "../core/clock.js";
import { hash, stableSort } from "../core/determinism.js";
import { RefusedError } from "../core/errors.js";
import { loadEngagement, type EngagementDoc } from "../engagement/config.js";
import type { Layout } from "../engagement/home.js";
import { dispositions, stateOf, type DispositionState } from "../findings/disposition.js";
import { runJudgments, type Judgment } from "../findings/judgments.js";
import { latestRunFindings } from "../findings/store.js";
import type { Finding } from "../findings/types.js";
import { readRunMetrics } from "../review/run.js";
import { loadRubric, type Rubric } from "../rubric/rubric.js";
import { EventLog, type Event } from "../state/events.js";

export interface RunInputs {
  readonly doc: EngagementDoc;
  readonly rubric: Rubric;
  readonly runId: string;
  readonly runStatus: "complete" | "partial" | "aborted";
  readonly findings: readonly Finding[];
  /** Judgment findings proposed against this run (M4), consultant severity overrides applied. */
  readonly judgments: readonly Judgment[];
  readonly states: ReadonlyMap<string, DispositionState>;
  readonly metrics: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /** Lane → final outcome, for lanes whose final action wasn't abort. */
  readonly lanes: ReadonlyMap<string, string>;
  readonly lanesRun: ReadonlySet<string>;
  readonly notes: readonly string[];
  readonly events: readonly Event[];
}

export function loadRunInputs(l: Layout, clock: Clock): RunInputs {
  const events = new EventLog(l.events, clock).read();
  const completed = events.findLast((e) => e.type === "run-completed");
  if (completed === undefined) throw new RefusedError("no completed review run yet (run `radr review`)");
  const runId = String(completed.data["run_id"]);
  const runStatus = completed.data["status"] as RunInputs["runStatus"];
  const { runId: storeRun, findings } = latestRunFindings(l.findings);
  if (runStatus !== "aborted" && storeRun !== runId) throw new RefusedError(`findings store is at ${String(storeRun)}, events at ${runId}`);
  const doc = loadEngagement(l.engagementYml);
  const lanes = new Map<string, string>();
  for (const e of events) {
    if (e.type !== "lane-completed" || e.data["run_id"] !== runId || e.data["action"] === "retry" || e.data["action"] === "abort") continue;
    lanes.set(String(e.data["lane"]), String(e.data["outcome"]));
  }
  const notes = Array.isArray(completed.data["notes"]) ? completed.data["notes"].map(String) : [];
  return {
    doc, rubric: loadRubric(doc.rubric), runId, runStatus,
    findings: runStatus === "aborted" ? [] : findings,
    judgments: runStatus === "aborted" ? [] : runJudgments(l.judgments, runId, events),
    states: dispositions(events), metrics: readRunMetrics(l, runId), lanes, lanesRun: new Set(lanes.keys()), notes, events,
  };
}

/** Hash of every present finding's current disposition: a report is only valid for these states. */
export function dispositionsHash(inp: Pick<RunInputs, "findings" | "judgments" | "states">): string {
  const tool = stableSort(inp.findings, (f) => f.id).map((f) => [f.id, inp.states.get(f.id) ?? "pending"]);
  if (inp.judgments.length === 0) return hash(tool);
  // With judgment findings, their state and (overridable) severity count too. Without any, the
  // hash is exactly what it was before M4, so earlier approvals still verify.
  return hash({ tool, judgments: inp.judgments.map((j) => [j.id, stateOf(inp.states, j.id), j.severity]) });
}
