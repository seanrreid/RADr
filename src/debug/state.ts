// Debug state (PRD §11, M5): a pure fold over the event log, plus the gates that order the
// method. The record is the events; files under debug/<id>/ are evidence the events hash.
//
// The repro contract is git-bisect-run's: exit 0 = the bug is absent; 125 = can't tell (skip);
// any other non-zero exit = present. A run that never produced an exit code is an `error`.
//
// Gates (invariant 7 and §11):
//   - a hypothesis is decided only by an experiment run recorded against it, and confirmed
//     only after the bug has been reproduced;
//   - root-caused needs a reproducing repro run and a confirmed hypothesis;
//   - cannot-reproduce needs at least one repro attempt and no reproducing one;
//   - a concluded debug takes no further decisions.

import { RefusedError } from "../core/errors.js";
import type { Event } from "../state/events.js";

export type RunKind = "repro" | "experiment" | "bisect" | "guard-without-fix" | "guard-with-fix";
export type RunOutcome = "present" | "absent" | "skip" | "error";

export interface DebugRun {
  readonly runId: string;
  readonly kind: RunKind;
  readonly commit: string;
  readonly scriptHash: string;
  readonly exitCode: number | null;
  readonly outcome: RunOutcome;
  readonly logRef: string;
  readonly hypothesisId?: string;
}

export interface Hypothesis {
  readonly id: string;
  readonly text: string;
  readonly source: "consultant" | "llm";
  readonly state: "proposed" | "confirmed" | "refuted";
  readonly decidedBy?: string;
  readonly reason?: string;
}

export interface DebugState {
  readonly id: string;
  readonly from: "issue" | "finding";
  readonly findingId?: string;
  readonly symptom: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly environment?: string;
  readonly firstSeen?: string;
  /** The approved commit the debug was opened at (where the repro must reproduce). */
  readonly commit: string;
  readonly runs: readonly DebugRun[];
  readonly hypotheses: readonly Hypothesis[];
  readonly bisect?: { readonly good: string; readonly bad: string; readonly firstBad: readonly string[] };
  readonly conclusion?: { readonly outcome: "root-caused" | "cannot-reproduce"; readonly hypothesisId?: string; readonly introducingCommit?: string; readonly summary: string };
}

/** The repro contract (git bisect run). */
export function outcomeOf(exitCode: number | null): RunOutcome {
  if (exitCode === null) return "error";
  if (exitCode === 0) return "absent";
  if (exitCode === 125) return "skip";
  return "present";
}

/** `{ [key]: value }` when the event carries that optional string field, else `{}`. */
function some<K extends string>(key: K, v: unknown): Partial<Record<K, string>> {
  return typeof v === "string" ? ({ [key]: v } as Record<K, string>) : {};
}

export function debugStates(events: readonly Event[]): Map<string, DebugState> {
  const out = new Map<string, DebugState>();
  const update = (id: string, f: (d: DebugState) => DebugState) => {
    const d = out.get(id);
    if (d !== undefined) out.set(id, f(d));
  };
  for (const e of events) {
    const d = e.data;
    const id = String(d["debug_id"]);
    switch (e.type) {
      case "debug-opened":
        out.set(id, {
          id, from: d["from"] as DebugState["from"], symptom: String(d["symptom"]), commit: String(d["commit"]), runs: [], hypotheses: [],
          ...some("findingId", d["finding_id"]),
          ...some("expected", d["expected"]),
          ...some("actual", d["actual"]),
          ...some("environment", d["environment"]),
          ...some("firstSeen", d["first_seen"]),
        });
        break;
      case "debug-run":
        update(id, (s) => ({
          ...s, runs: [...s.runs, {
            runId: String(d["run_id"]), kind: d["kind"] as RunKind, commit: String(d["commit"]), scriptHash: String(d["script_hash"]),
            exitCode: typeof d["exit_code"] === "number" ? d["exit_code"] : null, outcome: d["outcome"] as RunOutcome, logRef: String(d["log_ref"]),
            ...some("hypothesisId", d["hypothesis_id"]),
          }],
        }));
        break;
      case "debug-bisected":
        update(id, (s) => ({ ...s, bisect: { good: String(d["good"]), bad: String(d["bad"]), firstBad: (d["first_bad"] as string[]).map(String) } }));
        break;
      case "hypothesis-proposed":
        update(id, (s) => ({ ...s, hypotheses: [...s.hypotheses, { id: String(d["hypothesis_id"]), text: String(d["text"]), source: d["source"] as Hypothesis["source"], state: "proposed" }] }));
        break;
      case "hypothesis-decided":
        update(id, (s) => ({
          ...s, hypotheses: s.hypotheses.map((h) => (h.id === d["hypothesis_id"] ? { ...h, state: d["to"] as Hypothesis["state"], decidedBy: String(d["run_id"]), reason: String(d["reason"]) } : h)),
        }));
        break;
      case "debug-concluded":
        update(id, (s) => ({
          ...s, conclusion: {
            outcome: d["outcome"] as "root-caused" | "cannot-reproduce", summary: String(d["summary"]),
            ...some("hypothesisId", d["hypothesis_id"]),
            ...some("introducingCommit", d["introducing_commit"]),
          },
        }));
        break;
      default:
        break;
    }
  }
  return out;
}

export function getDebug(events: readonly Event[], id: string): DebugState {
  const d = debugStates(events).get(id);
  if (d === undefined) throw new RefusedError(`no debug ${id} in this engagement (radr debug list)`);
  return d;
}

/** Repro runs at the debug's own commit that showed the bug. */
export function reproducing(d: DebugState): DebugRun[] {
  return d.runs.filter((r) => r.kind === "repro" && r.commit === d.commit && r.outcome === "present");
}

export function assertOpen(d: DebugState): void {
  if (d.conclusion !== undefined) throw new RefusedError(`${d.id} is concluded (${d.conclusion.outcome}); open a new debug to continue`);
}

/** Gate: may `hypothesisId` be decided `to` with the evidence of `runId`? Throws why not. */
export function assertCanDecide(d: DebugState, hypothesisId: string, to: "confirmed" | "refuted", runId: string): void {
  assertOpen(d);
  const h = d.hypotheses.find((x) => x.id === hypothesisId);
  if (h === undefined) throw new RefusedError(`${d.id} has no hypothesis ${hypothesisId}`);
  if (h.state !== "proposed") throw new RefusedError(`${hypothesisId} is already ${h.state}`);
  const run = d.runs.find((r) => r.runId === runId);
  if (run === undefined) throw new RefusedError(`${d.id} has no run ${runId}`);
  if (run.kind !== "experiment" || run.hypothesisId !== hypothesisId) {
    throw new RefusedError(`${runId} is not an experiment recorded against ${hypothesisId}; only recorded evidence decides a hypothesis (radr debug experiment)`);
  }
  if (run.outcome === "error" || run.outcome === "skip") throw new RefusedError(`${runId} ended ${run.outcome}: it can't decide anything`);
  if (to === "confirmed" && reproducing(d).length === 0) {
    throw new RefusedError(`${d.id} has no reproducing run yet: no hypothesis can be confirmed before the bug is reproduced (radr debug repro)`);
  }
}

/** Gate (invariant 7): may the debug conclude with `outcome`? Throws why not. */
export function assertCanConclude(d: DebugState, outcome: "root-caused" | "cannot-reproduce", hypothesisId: string | undefined): void {
  assertOpen(d);
  if (outcome === "cannot-reproduce") {
    if (!d.runs.some((r) => r.kind === "repro")) throw new RefusedError(`${d.id}: cannot-reproduce needs at least one recorded repro attempt`);
    if (reproducing(d).length > 0) throw new RefusedError(`${d.id} was reproduced (${reproducing(d).map((r) => r.runId).join(", ")}); it can't conclude cannot-reproduce`);
    return;
  }
  if (reproducing(d).length === 0) throw new RefusedError(`${d.id}: a root cause needs a recorded run that reproduces the bug (radr debug repro)`);
  if (hypothesisId === undefined) throw new RefusedError(`${d.id}: a root cause names the confirmed hypothesis (--hypothesis H-…)`);
  const h = d.hypotheses.find((x) => x.id === hypothesisId);
  if (h?.state !== "confirmed") throw new RefusedError(`${hypothesisId} is not a confirmed hypothesis of ${d.id}`);
}

/** Next id of a kind across the engagement: D-, DR-, H-. */
export function nextId(events: readonly Event[], prefix: "D" | "DR" | "H"): string {
  const field = prefix === "D" ? "debug_id" : prefix === "DR" ? "run_id" : "hypothesis_id";
  const type = prefix === "D" ? "debug-opened" : prefix === "DR" ? "debug-run" : "hypothesis-proposed";
  const n = events.filter((e) => e.type === type && typeof e.data[field] === "string").length + 1;
  return `${prefix}-${String(n).padStart(4, "0")}`;
}
