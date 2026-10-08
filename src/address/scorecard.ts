// Triage scorecard (PRD §5, M2 AC6): a pure function of the latest run's stored metrics,
// findings, and dispositions, evaluated against rubric v1 §6. A metric whose lane didn't run
// is grey ("unavailable"), never estimated.

import type { DispositionState } from "../findings/disposition.js";
import type { Finding } from "../findings/types.js";
import type { CensusMetrics } from "../normalize/adapters.js";
import type { ScorecardSpec } from "../rubric/rubric.js";

export type Rating = "green" | "amber" | "red" | "grey";
export type Verdict = "healthy" | "needs-attention" | "at-risk";

export interface ScoreRow {
  readonly key: string;
  readonly label: string;
  readonly value: number | string | null;
  readonly rating: Rating;
}

export interface Scorecard {
  readonly rows: readonly ScoreRow[];
  readonly verdict: Verdict;
  readonly counts: Readonly<Record<Rating, number>>;
}

export interface ScorecardInputs {
  readonly metrics: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly findings: readonly Finding[];
  readonly states: ReadonlyMap<string, DispositionState>;
  /** Lanes that ran (any outcome but abort) in the scored run. */
  readonly lanesRun: ReadonlySet<string>;
}

const LINT_ERROR_SEVERITIES = new Set(["2", "error", "fatal"]);

function rateNumeric(spec: ScorecardSpec["metrics"][string], value: number | null): Rating {
  if (value === null) return "grey";
  if (spec.better === "lower") return value <= spec.green ? "green" : value >= spec.red ? "red" : "amber";
  return value >= spec.green ? "green" : value <= spec.red ? "red" : "amber";
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);

/** Raw numeric values per metric key; null = unavailable. Integer arithmetic only. */
function nothingLinted(lint: Readonly<Record<string, unknown>> | undefined): boolean {
  const linted = lint?.["linted"];
  return Array.isArray(linted) && linted.length === 0;
}

export function metricValues(inp: ScorecardInputs): Record<string, number | null> {
  const live = inp.findings.filter((f) => inp.states.get(f.id) !== "dismissed");
  const census = inp.metrics["census"] as CensusMetrics | undefined;
  const tests = inp.metrics["tests"];
  const history = inp.metrics["history"];
  const maint = inp.metrics["maint"];
  const sourceCode = num(tests?.["source_code"]);
  const lintErrors = live.filter((f) => f.lane === "lint" && LINT_ERROR_SEVERITIES.has(f.tool_severity)).length;
  return {
    // No linter ran for any stack in scope: not measured, never 0 (dogfood 2026-10-08).
    lint_errors_per_kloc_x10:
      inp.lanesRun.has("lint") && census !== undefined && sourceCode !== null && sourceCode > 0 && !nothingLinted(inp.metrics["lint"]) ? Math.floor((lintErrors * 10000) / sourceCode) : null,
    type_errors: inp.lanesRun.has("types") ? live.filter((f) => f.lane === "types" && f.tool_severity === "error").length : null,
    duplication_pct: num(maint?.["duplication_pct"]),
    complex_functions_pct: num(maint?.["complex_functions_pct"]),
    test_ratio_pct: num(tests?.["test_ratio_pct"]),
    bus_factor: num(history?.["bus_factor"]),
    churn_hotspot_pct: num(history?.["churn_hotspot_pct"]),
  };
}

function rateCategorical(key: string, inp: ScorecardInputs): { value: string | null; rating: Rating } {
  const live = inp.findings.filter((f) => inp.states.get(f.id) !== "dismissed");
  if (key === "dependency_vulns") {
    if (!inp.lanesRun.has("sca")) return { value: null, rating: "grey" };
    // No lockfile to read means nothing was assessed: never "none" (dogfood 2026-10-08).
    const locks = inp.metrics["sca"]?.["lockfiles"];
    if (Array.isArray(locks) && locks.length === 0) return { value: null, rating: "grey" };
    const deps = live.filter((f) => f.lane === "sca");
    if (deps.some((f) => f.severity === "critical" || f.kev === true)) return { value: "critical or known-exploited present", rating: "red" };
    if (deps.some((f) => f.severity === "high")) return { value: "high present", rating: "amber" };
    return { value: deps.length === 0 ? "none" : "medium or lower only", rating: "green" };
  }
  if (key === "secrets") {
    if (!inp.lanesRun.has("secrets")) return { value: null, rating: "grey" };
    const secrets = live.filter((f) => f.lane === "secrets");
    if (secrets.some((f) => f.tags.includes("present-at-head"))) return { value: "present in current code", rating: "red" };
    if (secrets.some((f) => f.tags.includes("history-only"))) return { value: "history only", rating: "amber" };
    return { value: "none", rating: "green" };
  }
  return { value: null, rating: "grey" };
}

export function computeScorecard(spec: ScorecardSpec, inp: ScorecardInputs): Scorecard {
  const values = metricValues(inp);
  const rows: ScoreRow[] = [];
  for (const [key, cat] of Object.entries(spec.categorical)) {
    const r = rateCategorical(key, inp);
    rows.push({ key, label: cat.label, value: r.value, rating: r.rating });
  }
  for (const [key, m] of Object.entries(spec.metrics)) {
    const value = Object.hasOwn(values, key) ? (values[key] ?? null) : null;
    rows.push({ key, label: m.label, value, rating: rateNumeric(m, value) });
  }
  const counts: Record<Rating, number> = { green: 0, amber: 0, red: 0, grey: 0 };
  for (const r of rows) counts[r.rating]++;
  const redKeys = new Set(rows.filter((r) => r.rating === "red").map((r) => r.key));
  const v = spec.verdict;
  let verdict: Verdict = "healthy";
  if (v.at_risk.red_in.some((k) => redKeys.has(k)) || counts.red >= v.at_risk.reds_at_least) verdict = "at-risk";
  else if (counts.red >= v.needs_attention.reds_at_least || counts.amber >= v.needs_attention.ambers_at_least) verdict = "needs-attention";
  return { rows, verdict, counts };
}
