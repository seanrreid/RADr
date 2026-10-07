// Metric lanes (M2 W1): history (churn, hotspots, bus factor) and tests (static test ratio).
// Both are pure functions of the approved SHA: no wall clock, no external tool beyond git.
// The history window is anchored to the approved commit's own committer date, never "now".

import { stableSort } from "../core/determinism.js";
import { matchesAny } from "../core/glob.js";
import { git } from "../engagement/git.js";
import type { CensusMetrics } from "../normalize/adapters.js";
import { recordRun, type Lane, type LaneResult } from "./lane.js";

const WINDOW_SECONDS = 365 * 24 * 60 * 60;
const BUS_FACTOR_SHARE_PCT = 50;

export interface Commit {
  readonly sha: string;
  readonly author: string;
  readonly time: number;
  /** path → lines added + deleted (binary files count 0). */
  readonly churn: Readonly<Record<string, number>>;
}

/** Parse `git log --format=%x00%H%x09%ae%x09%ct --numstat --no-renames`. */
export function parseGitLog(text: string): Commit[] {
  const commits: Commit[] = [];
  for (const block of text.split("\0").slice(1)) {
    const [header, ...rest] = block.split("\n");
    const [sha, author, time] = (header ?? "").split("\t");
    if (sha === undefined || author === undefined || time === undefined || !/^[0-9a-f]{40}$/.test(sha) || !/^\d+$/.test(time)) {
      throw new Error(`unexpected git log header: ${(header ?? "").slice(0, 80)}`);
    }
    const churn: Record<string, number> = {};
    for (const line of rest) {
      if (line === "") continue;
      const [a, d, ...p] = line.split("\t");
      const file = p.join("\t");
      if (a === undefined || d === undefined || file === "") continue;
      const n = (a === "-" ? 0 : Number.parseInt(a, 10)) + (d === "-" ? 0 : Number.parseInt(d, 10));
      churn[file] = (churn[file] ?? 0) + n;
    }
    commits.push({ sha, author: author.toLowerCase(), time: Number.parseInt(time, 10), churn });
  }
  return commits;
}

export interface HistoryMetrics {
  readonly [key: string]: unknown;
  readonly window: { readonly head_time: number; readonly since: number; readonly commits: number; readonly all_commits: number };
  readonly authors: number;
  readonly bus_factor: number;
  readonly churn_total: number;
  /** Share of window churn in the top-decile-complexity files; null if census per-file data is missing. */
  readonly churn_hotspot_pct: number | null;
  readonly hotspots: readonly { readonly file: string; readonly churn: number; readonly complexity: number }[];
}

/** Fewest authors whose commits cover ≥ 50% of commits (ties broken by email, code-point order). */
export function busFactor(commits: readonly Commit[]): number {
  if (commits.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const c of commits) counts.set(c.author, (counts.get(c.author) ?? 0) + 1);
  const ranked = stableSort([...counts], ([email, n]) => [-n, email]);
  let covered = 0;
  for (let i = 0; i < ranked.length; i++) {
    covered += ranked[i]?.[1] ?? 0;
    if (covered * 100 >= commits.length * BUS_FACTOR_SHARE_PCT) return i + 1;
  }
  return ranked.length;
}

export function historyMetrics(all: readonly Commit[], census: CensusMetrics | undefined): HistoryMetrics {
  const headTime = all.reduce((m, c) => Math.max(m, c.time), 0);
  const since = headTime - WINDOW_SECONDS;
  const recent = all.filter((c) => c.time >= since);
  const window = recent.length > 0 ? recent : all;

  const churn = new Map<string, number>();
  for (const c of window) for (const [f, n] of Object.entries(c.churn)) churn.set(f, (churn.get(f) ?? 0) + n);
  const churnTotal = [...churn.values()].reduce((a, b) => a + b, 0);

  let hotspotPct: number | null = null;
  let hotspots: HistoryMetrics["hotspots"] = [];
  if (census !== undefined && Object.keys(census.files).length > 0) {
    const complex = stableSort(Object.entries(census.files).filter(([, m]) => m.complexity > 0), ([f, m]) => [-m.complexity, f]);
    const top = complex.slice(0, Math.ceil(complex.length / 10));
    const topSet = new Set(top.map(([f]) => f));
    const hotChurn = [...churn].filter(([f]) => topSet.has(f)).reduce((a, [, n]) => a + n, 0);
    hotspotPct = churnTotal === 0 ? 0 : Math.floor((hotChurn * 100) / churnTotal);
    hotspots = stableSort(
      complex.filter(([f]) => (churn.get(f) ?? 0) > 0).map(([file, m]) => ({ file, churn: churn.get(file) ?? 0, complexity: m.complexity })),
      (h) => [-(h.churn * h.complexity), h.file],
    ).slice(0, 10);
  }
  return {
    window: { head_time: headTime, since, commits: window.length, all_commits: all.length },
    authors: new Set(window.map((c) => c.author)).size,
    bus_factor: busFactor(window),
    churn_total: churnTotal,
    churn_hotspot_pct: hotspotPct,
    hotspots,
  };
}

export const history: Lane = {
  id: "history",
  tools: [],
  async run(ctx): Promise<LaneResult> {
    const r = await git(["log", "--format=%x00%H%x09%ae%x09%ct", "--numstat", "--no-renames", ctx.doc.source.sha, "--"], ctx.layout.mirror);
    const toolRun = recordRun(ctx, "history", "git-log", "git-log.txt", r);
    if (r.outcome !== "ok") return { outcome: r.outcome === "tool-missing" ? "tool-missing" : "tool-error", tools: [toolRun], findings: [], detail: r.stderr.toString().trim() };
    try {
      const census = ctx.metrics["census"] as CensusMetrics | undefined;
      return { outcome: "success", tools: [toolRun], findings: [], metrics: historyMetrics(parseGitLog(r.stdout.toString("utf8")), census) };
    } catch (e) {
      return { outcome: "parse-error", tools: [toolRun], findings: [], detail: e instanceof Error ? e.message : String(e) };
    }
  },
};

/** Paths that are tests, across the supported stacks. */
export const TEST_GLOBS = [
  "**/test/**", "**/tests/**", "**/__tests__/**", "**/spec/**", "**/*.test.*", "**/*.spec.*",
  "**/test_*.py", "**/*_test.py", "**/*_test.go", "**/conftest.py",
];

/** Languages scc reports that count as program source (not data, docs, or config). */
const CODE_LANGUAGES = new Set([
  "TypeScript", "TypeScript Typings", "JavaScript", "TSX", "JSX", "Python", "Go", "Rust", "Java", "Kotlin", "PHP", "Ruby", "C#",
  "Vue", "Svelte", "Scala", "Swift", "C", "C++", "C Header", "C++ Header",
]);

export function testMetrics(census: CensusMetrics): Record<string, unknown> {
  let testFiles = 0;
  let testCode = 0;
  let sourceFiles = 0;
  let sourceCode = 0;
  for (const [file, m] of Object.entries(census.files)) {
    if (!CODE_LANGUAGES.has(m.language)) continue;
    if (matchesAny(file, TEST_GLOBS)) {
      testFiles++;
      testCode += m.code;
    } else {
      sourceFiles++;
      sourceCode += m.code;
    }
  }
  return {
    test_files: testFiles, test_code: testCode, source_files: sourceFiles, source_code: sourceCode,
    test_ratio_pct: sourceCode === 0 ? null : Math.floor((testCode * 100) / sourceCode),
  };
}

export const tests: Lane = {
  id: "tests",
  tools: [],
  run(ctx): Promise<LaneResult> {
    const census = ctx.metrics["census"] as CensusMetrics | undefined;
    if (census === undefined) return Promise.resolve({ outcome: "parse-error", tools: [], findings: [], detail: "census metrics unavailable (tests lane needs census)" });
    return Promise.resolve({ outcome: "success", tools: [], findings: [], metrics: testMetrics(census) });
  },
};
