// Judgment findings (PRD §8, §9; M4). The LLM lane PROPOSES them; nothing else about them is
// the model's to decide. judgments.jsonl is append-only canonical JSON, kept apart from
// findings.jsonl so the tool findings-set hash (the determinism eval, AC18) never depends on
// model output. Each record is announced by a `finding-proposed` event that freezes its hash.
//
// A judgment is a Finding with class "judgment": the report and the CLI treat it like any other
// finding, labelled. Its severity comes from the rubric (radr-judgment), then a consultant's
// severity-override, never from the model. It starts `proposed` (see disposition.ts).

import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { canonicalJson, hash, stableSort } from "../core/determinism.js";
import { RefusedError } from "../core/errors.js";
import { inScope } from "../core/glob.js";
import type { EngagementDoc } from "../engagement/config.js";
import type { Rubric } from "../rubric/rubric.js";
import type { Event, EventLog } from "../state/events.js";
import { NO_VULN_CONTEXT } from "../rubric/rubric.js";
import type { Category, Finding, FindingDraft, Severity } from "./types.js";

export const JUDGMENT_CATEGORIES: readonly Category[] = ["security", "quality", "maintainability", "test"];
export const MAX_TITLE = 200;
export const MAX_RATIONALE = 2000;

/** What the agent returns for one proposed judgment finding (validated here, not trusted). */
export interface JudgmentProposal {
  readonly title: string;
  readonly category: string;
  readonly file: string;
  readonly line: number;
  readonly end_line: number;
  readonly rationale: string;
}

export interface Judgment extends Finding {
  readonly class: "judgment";
  readonly run_id: string;
  readonly call_id: string;
}

export function readJudgments(file: string): Judgment[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  if (text !== "" && !text.endsWith("\n")) throw new RefusedError(`${file}: last record is truncated`);
  return text.split("\n").filter((l) => l !== "").map((line, i) => {
    const rec = JSON.parse(line) as Judgment;
    if (canonicalJson(rec) !== line) throw new RefusedError(`${file}:${i + 1}: record is not in canonical form`);
    return rec;
  });
}

/** Why a proposal can't be a finding, or null when its anchor is real and in scope. */
export function anchorProblem(p: JudgmentProposal, worktree: string, paths: EngagementDoc["paths"]): string | null {
  if (!JUDGMENT_CATEGORIES.includes(p.category as Category)) return `category "${p.category}" is not one of ${JUDGMENT_CATEGORIES.join(", ")}`;
  if (p.title.trim() === "" || p.title.length > MAX_TITLE) return `title must be 1–${String(MAX_TITLE)} characters`;
  if (p.rationale.trim() === "" || p.rationale.length > MAX_RATIONALE) return `rationale must be 1–${String(MAX_RATIONALE)} characters`;
  const rel = p.file;
  if (rel === "" || path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..") || rel.includes("\\")) return `file "${rel}" is not a repo-relative POSIX path`;
  if (!inScope(rel, paths)) return `file "${rel}" is outside the approved scope paths`;
  const abs = path.join(worktree, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) return `file "${rel}" does not exist at the approved commit`;
  const lines = readFileSync(abs, "utf8").split(/\r?\n/).length;
  if (!Number.isInteger(p.line) || !Number.isInteger(p.end_line) || p.line < 1 || p.end_line < p.line || p.end_line > lines) {
    return `lines ${String(p.line)}–${String(p.end_line)} are not within ${rel} (1–${String(lines)})`;
  }
  return null;
}

/** Identity: where it points and what it says. Re-proposing the same judgment is a no-op. */
function judgmentFingerprint(p: JudgmentProposal): string {
  return hash({ kind: "judgment", file: p.file, line: p.line, end_line: p.end_line, title: p.title.trim() });
}

export interface ProposeResult {
  readonly added: readonly Judgment[];
  readonly duplicates: number;
  readonly rejected: readonly { readonly proposal: JudgmentProposal; readonly reason: string }[];
}

export interface ProposeContext {
  readonly file: string;
  readonly worktree: string;
  readonly doc: EngagementDoc;
  readonly rubric: Rubric;
  readonly runId: string;
  readonly callId: string;
  readonly log: EventLog;
  readonly actor: string;
}

/** Validate anchors, assess severity with the rubric, append records + `finding-proposed` events. */
export function proposeJudgments(ctx: ProposeContext, proposals: readonly JudgmentProposal[]): ProposeResult {
  const existing = readJudgments(ctx.file);
  const known = new Set(existing.map((j) => j.fingerprint));
  let next = existing.reduce((max, j) => Math.max(max, Number.parseInt(j.id.slice(2), 10)), 0) + 1;
  const added: Judgment[] = [];
  const rejected: { proposal: JudgmentProposal; reason: string }[] = [];
  let duplicates = 0;
  for (const p of proposals) {
    const problem = anchorProblem(p, ctx.worktree, ctx.doc.paths);
    if (problem !== null) {
      rejected.push({ proposal: p, reason: problem });
      continue;
    }
    const fingerprint = judgmentFingerprint(p);
    if (known.has(fingerprint)) {
      duplicates++;
      continue;
    }
    const draft: FindingDraft = {
      lane: "triage", tool: "radr-judgment", tool_version: "llm", rule_id: "judgment", category: p.category as Category,
      file: p.file, line: p.line, end_line: p.end_line, message: `${p.title.trim()}: ${p.rationale.trim()}`,
      tool_severity: "judgment", snippet: null, engine_fingerprint: null, cve: null, aliases: [], cvss: null,
      raw_ref: `llm/${ctx.callId}.response.txt`, tags: [],
    };
    // The rubric decides severity. A rubric without a radr-judgment entry (v0, v1) refuses, and
    // the proposal is rejected: never a default severity.
    let assessed: ReturnType<Rubric["assess"]>;
    try {
      assessed = ctx.rubric.assess(draft, NO_VULN_CONTEXT, { engagementType: ctx.doc.engagement_type });
    } catch (e) {
      if (!(e instanceof RefusedError)) throw e;
      rejected.push({ proposal: p, reason: `rubric ${ctx.rubric.version} has no judgment entry (judgment findings need rubric v2)` });
      continue;
    }
    const j: Judgment = {
      ...draft, type: "finding", id: `J-${String(next++).padStart(4, "0")}`, fingerprint, class: "judgment",
      severity: assessed.severity, epss_bp: null, kev: null, rubric_version: ctx.rubric.version, snippet_hash: null,
      run_id: ctx.runId, call_id: ctx.callId,
    };
    appendFileSync(ctx.file, `${canonicalJson(j)}\n`);
    ctx.log.append("finding-proposed", ctx.actor, { finding_id: j.id, run_id: ctx.runId, call_id: ctx.callId, record_hash: hash(j) });
    known.add(fingerprint);
    added.push(j);
  }
  return { added, duplicates, rejected };
}

/** Consultant severity decisions: finding id → the latest override. */
export function severityOverrides(events: readonly Event[]): Map<string, Severity> {
  const out = new Map<string, Severity>();
  for (const e of events) if (e.type === "severity-override") out.set(String(e.data["finding_id"]), e.data["to"] as Severity);
  return out;
}

/** Judgments proposed against `runId`, with any severity override applied, in id order. */
export function runJudgments(file: string, runId: string, events: readonly Event[]): Judgment[] {
  const overrides = severityOverrides(events);
  return stableSort(readJudgments(file).filter((j) => j.run_id === runId), (j) => j.id)
    .map((j) => ({ ...j, severity: overrides.get(j.id) ?? j.severity }));
}
