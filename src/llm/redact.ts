// What the agent may see of a finding, per LLM policy (PRD §9). Deterministic, and applied
// before invokeAgent: the gate persists exactly what this module produced.
//
//   metadata-only  rule IDs, paths, lines, severities, metrics; no snippet. A tool message that
//                  quotes the code it matched (rule messages may interpolate metavariables) is
//                  replaced by the rule ID.
//   code-allowed   the same, plus the anchored lines ±CONTEXT_LINES, bounded per finding.
//   secrets        whatever the policy, a secrets finding carries neither snippet nor message,
//                  and no code is sent from a file where the secrets lane found anything (a
//                  neighbouring finding's ±5 lines could include the secret; history findings'
//                  line numbers are from old commits, so line-level redaction can't be trusted).
//
// "Quotes the code" means: the message, with whitespace removed, contains any QUOTE_RUN-character
// run of the anchored source lines with whitespace removed (the whole file for line 0). The
// invariant-3 eval (leakedRuns) applies the same measure to every prompt against the whole repo.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { compareCodePoints } from "../core/determinism.js";
import type { Finding } from "../findings/types.js";
import type { LlmPolicy } from "./policy.js";

export const QUOTE_RUN = 12;
export const CONTEXT_LINES = 5;
export const MAX_SNIPPET_LINES = 40;
export const MAX_SNIPPET_BYTES = 4096;

/** A finding as the agent sees it. Every string field except `message` and `code` is metadata. */
export interface PromptFinding {
  readonly id: string;
  readonly lane: string;
  readonly tool: string;
  readonly rule_id: string;
  readonly category: string;
  readonly severity: string;
  readonly file: string;
  readonly line: number;
  readonly end_line: number;
  readonly message: string;
  readonly cve: string | null;
  readonly cvss: string | null;
  /** code-allowed only: the source lines [code_start, …], numbered by the reader. */
  readonly code?: string;
  readonly code_start?: number;
}

const squeeze = (s: string): string => s.replace(/\s+/g, "");

/** Every QUOTE_RUN-length window of `s` (whitespace already removed). */
function windows(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + QUOTE_RUN <= s.length; i++) out.add(s.slice(i, i + QUOTE_RUN));
  return out;
}

/** True when `text` contains a QUOTE_RUN-character run of `source` (whitespace ignored). */
export function quotes(text: string, source: string): boolean {
  const t = squeeze(text);
  if (t.length < QUOTE_RUN) return false;
  const w = windows(squeeze(source));
  for (let i = 0; i + QUOTE_RUN <= t.length; i++) if (w.has(t.slice(i, i + QUOTE_RUN))) return true;
  return false;
}

function fileLines(worktree: string, file: string): string[] | null {
  const abs = path.join(worktree, file);
  // Findings are repo-relative; anything that resolves outside the worktree is never read.
  if (!abs.startsWith(worktree + path.sep) || !existsSync(abs) || !statSync(abs).isFile()) return null;
  return readFileSync(abs, "utf8").split(/\r?\n/);
}

function anchored(lines: readonly string[], f: Finding): string {
  if (f.line <= 0) return lines.join("\n");
  return lines.slice(f.line - 1, Math.max(f.line, f.end_line)).join("\n");
}

/** Files the secrets lane reported anything in: no code is ever sent from them. */
export function secretFiles(findings: readonly Finding[]): Set<string> {
  return new Set(findings.filter((f) => f.category === "secrets").map((f) => f.file));
}

export function promptFinding(f: Finding, policy: Exclude<LlmPolicy, "off">, worktree: string, noCode: ReadonlySet<string> = new Set()): PromptFinding {
  const base = {
    id: f.id, lane: f.lane, tool: f.tool, rule_id: f.rule_id, category: f.category, severity: f.severity,
    file: f.file, line: f.line, end_line: f.end_line, cve: f.cve, cvss: f.cvss,
  };
  if (f.category === "secrets") return { ...base, message: f.rule_id };
  const lines = fileLines(worktree, f.file);
  // A message about a file radr can't read can't be checked, so it isn't sent.
  const message = lines === null ? f.rule_id : quotes(f.message, anchored(lines, f)) ? f.rule_id : f.message;
  if (policy === "metadata-only" || lines === null || f.line <= 0 || noCode.has(f.file)) return { ...base, message };

  const start = Math.max(1, f.line - CONTEXT_LINES);
  const end = Math.min(lines.length, Math.max(f.line, f.end_line) + CONTEXT_LINES, start + MAX_SNIPPET_LINES - 1);
  let code = lines.slice(start - 1, end).join("\n");
  if (Buffer.byteLength(code) > MAX_SNIPPET_BYTES) code = Buffer.from(code).subarray(0, MAX_SNIPPET_BYTES).toString("utf8").replace(/�$/, "");
  return { ...base, message: f.message, code, code_start: start };
}

/** Repo files (sorted, .git excluded) for the invariant-3 scan. */
export function repoFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort(compareCodePoints)) {
      if (name === ".git") continue;
      const p = path.join(dir, name);
      const st = statSync(p, { throwIfNoEntry: false });
      if (st?.isDirectory() === true) walk(p);
      else if (st?.isFile() === true) out.push(p);
    }
  };
  walk(root);
  return out;
}

/**
 * Invariant 3: the files under `root` from which `text` quotes a QUOTE_RUN-character run. `text`
 * is the free text of a prompt: radr's own instructions and metadata fields excluded.
 */
export function leakedRuns(text: string, root: string): string[] {
  const t = squeeze(text);
  if (t.length < QUOTE_RUN) return [];
  const runs = windows(t);
  const hits: string[] = [];
  for (const file of repoFiles(root)) {
    const s = squeeze(readFileSync(file, "utf8"));
    for (let i = 0; i + QUOTE_RUN <= s.length; i++) {
      if (runs.has(s.slice(i, i + QUOTE_RUN))) {
        hits.push(path.relative(root, file));
        break;
      }
    }
  }
  return hits;
}
