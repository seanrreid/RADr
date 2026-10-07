// Shared lane plumbing: run one tool step, store its raw output, adapt it, and combine steps
// into a lane result. Every failure maps to a typed outcome for policy/matrix.yml.

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { stableSort } from "../core/determinism.js";
import type { ExecResult } from "../core/exec.js";
import type { FindingDraft } from "../findings/types.js";
import { ParseError, type SnippetReader } from "../normalize/adapters.js";
import { execOutcome, recordFileRun, recordRun, type LaneContext, type LaneOutcome, type LaneResult, type ToolRun } from "./lane.js";

/** Most severe first: a lane with several tools reports the worst of their outcomes. */
const OUTCOME_RANK: readonly LaneOutcome[] = ["tool-missing", "version-drift", "tool-error", "timeout", "output-cap", "parse-error", "success"];
export function worstOutcome(outcomes: readonly LaneOutcome[]): LaneOutcome {
  return OUTCOME_RANK.find((o) => outcomes.includes(o)) ?? "success";
}

/**
 * The worktree's REAL path. Tools report resolved paths (on macOS /var → /private/var), so
 * normalizing against an unresolved root would make every in-repo path look like an escape.
 */
export function realWorktree(ctx: LaneContext): string {
  return realpathSync(ctx.layout.worktree);
}

export function snippetReader(root: string): SnippetReader {
  return (file, start, end) => {
    const abs = path.join(root, file);
    if (!existsSync(abs)) return null;
    const lines = readFileSync(abs, "utf8").split(/\r?\n/);
    const slice = lines.slice(start - 1, end);
    return slice.length === 0 ? null : slice.join("\n");
  };
}

export function bin(ctx: LaneContext, tool: string): string {
  return ctx.tools.bins[tool] ?? `/nonexistent/${tool}`; // missing → exec reports tool-missing
}

/** Run one tool, store its output, and adapt it — mapping every failure to a typed outcome. */
export async function step(
  ctx: LaneContext,
  lane: string,
  tool: string,
  file: string,
  exec: () => Promise<ExecResult>,
  adapt: (raw: string, rawRef: string) => FindingDraft[],
): Promise<{ outcome: LaneOutcome; run: ToolRun; findings: FindingDraft[]; detail?: string }> {
  const r = await exec();
  const toolRun = recordRun(ctx, lane, tool, file, r);
  const outcome = execOutcome(r.outcome);
  if (outcome !== "success") return { outcome, run: toolRun, findings: [], detail: `${tool}: ${r.error ?? (r.stderr.toString().trim().split("\n").at(-1) || r.outcome)}` };
  try {
    return { outcome, run: toolRun, findings: adapt(r.stdout.toString("utf8"), toolRun.raw_ref ?? "") };
  } catch (e) {
    if (e instanceof ParseError) return { outcome: "parse-error", run: toolRun, findings: [], detail: e.message };
    throw e;
  }
}

export interface StepOutcome {
  readonly outcome: LaneOutcome;
  readonly run?: ToolRun;
  readonly findings: readonly FindingDraft[];
  readonly detail?: string;
}

export function combine(steps: readonly StepOutcome[], metrics?: Record<string, unknown>): LaneResult {
  const detail = steps.map((s) => s.detail).filter((d) => d !== undefined).join("; ");
  return {
    outcome: worstOutcome(steps.map((s) => s.outcome)),
    tools: steps.flatMap((s) => (s.run === undefined ? [] : [s.run])),
    findings: steps.flatMap((s) => s.findings),
    ...(metrics !== undefined ? { metrics } : {}),
    ...(detail !== "" ? { detail } : {}),
  };
}

/** Like step(), for tools that write their report to a file: the report is the raw evidence. */
export async function fileStep(
  ctx: LaneContext,
  lane: string,
  tool: string,
  report: string,
  exec: () => Promise<ExecResult>,
  adapt: (raw: string, rawRef: string) => FindingDraft[],
): Promise<{ outcome: LaneOutcome; run: ToolRun; findings: FindingDraft[]; detail?: string }> {
  const r = await exec();
  const logRun = recordRun(ctx, lane, tool, `${path.basename(report)}.log`, r);
  const outcome = execOutcome(r.outcome);
  if (outcome !== "success") return { outcome, run: logRun, findings: [], detail: `${tool}: ${r.error ?? (r.stderr.toString().trim().split("\n").at(-1) || r.outcome)}` };
  if (!existsSync(report)) return { outcome: "parse-error", run: logRun, findings: [], detail: `${tool} wrote no report` };
  const data = readFileSync(report);
  const toolRun = recordFileRun(ctx, tool, report, data, r);
  try {
    return { outcome, run: toolRun, findings: adapt(data.toString("utf8"), toolRun.raw_ref ?? "") };
  } catch (e) {
    if (e instanceof ParseError) return { outcome: "parse-error", run: toolRun, findings: [], detail: e.message };
    throw e;
  }
}

/** Every regular file under root (repo-relative POSIX paths, code-point sorted), skipping .git and symlinks. */
export function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const name of readdirSync(path.join(root, rel))) {
      if (name === ".git") continue;
      const r = rel === "" ? name : `${rel}/${name}`;
      const st = lstatSync(path.join(root, r));
      if (st.isDirectory()) walk(r);
      else if (st.isFile()) out.push(r);
    }
  };
  walk("");
  return stableSort(out, (x) => x);
}
