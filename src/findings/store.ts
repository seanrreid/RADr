// Findings store (T5.2, T5.4). findings.jsonl is append-only canonical JSON:
//   {"type":"finding", ...}       first time a fingerprint is seen (stable F-NNNN id)
//   {"type":"run-findings", ...}  which finding ids a run observed
// Identity (fingerprint) excludes line numbers, so a finding survives code shifting around it.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { canonicalJson, hash, hashBytes, normalizeSnippet, stableSort } from "../core/determinism.js";
import { RefusedError } from "../core/errors.js";
import { inScope } from "../core/glob.js";
import type { EngagementDoc } from "../engagement/config.js";
import { NO_VULN_CONTEXT, type Rubric, type VulnContext } from "../rubric/rubric.js";
import type { Finding, FindingDraft } from "./types.js";

export interface RunFindings {
  readonly type: "run-findings";
  readonly run_id: string;
  readonly finding_ids: readonly string[];
}


const ID_WIDTH = 4;

export function readStore(file: string): { findings: Finding[]; runs: RunFindings[] } {
  if (!existsSync(file)) return { findings: [], runs: [] };
  const findings: Finding[] = [];
  const runs: RunFindings[] = [];
  const text = readFileSync(file, "utf8");
  if (text !== "" && !text.endsWith("\n")) throw new RefusedError(`${file}: last record is truncated`);
  text.split("\n").filter((l) => l !== "").forEach((line, i) => {
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      throw new RefusedError(`${file}:${i + 1}: not valid JSON`);
    }
    if (canonicalJson(rec) !== line) throw new RefusedError(`${file}:${i + 1}: record is not in canonical form`);
    const type = (rec as { type?: unknown }).type;
    if (type === "finding") findings.push(rec as Finding);
    else if (type === "run-findings") runs.push(rec as RunFindings);
    else throw new RefusedError(`${file}:${i + 1}: unknown record type`);
  });
  // A finding id may have several records (re-assessed across runs): the latest one wins.
  const latest = new Map<string, Finding>();
  for (const f of findings) latest.set(f.id, f);
  return { findings: [...latest.values()], runs };
}

/** Identity key before occurrence numbering: engine fingerprint, else tool+rule+path+code. */
function identityKey(d: FindingDraft, snippetHash: string | null): string {
  if (d.engine_fingerprint !== null) return `engine:${d.tool}:${d.engine_fingerprint}`;
  return `code:${d.tool}:${d.rule_id}:${d.file}:${snippetHash ?? `line:${d.line}`}`;
}

export interface Fingerprinted {
  readonly draft: FindingDraft;
  readonly fingerprint: string;
  readonly snippetHash: string | null;
}

/**
 * Fingerprint drafts. Identical key collisions (same rule, file, and code text twice) are
 * numbered by position, so two copies of the same mistake stay two findings.
 */
export function fingerprintDrafts(drafts: readonly FindingDraft[]): Fingerprinted[] {
  const withKeys = drafts.map((d) => {
    const snippetHash = d.snippet === null ? null : hashBytes(normalizeSnippet(d.snippet));
    return { draft: d, snippetHash, key: identityKey(d, snippetHash) };
  });
  const ordered = stableSort(withKeys, (x) => [x.key, x.draft.line, x.draft.end_line, x.draft.message, x.draft.raw_ref]);
  const seen = new Map<string, number>();
  return ordered.map((x) => {
    const n = seen.get(x.key) ?? 0;
    seen.set(x.key, n + 1);
    return { draft: x.draft, snippetHash: x.snippetHash, fingerprint: hash({ key: x.key, occurrence: n }) };
  });
}

export interface IngestResult {
  readonly present: Finding[];
  readonly added: number;
  /** Existing findings whose assessment or location changed (appended as new records). */
  readonly updated: number;
  readonly outOfScope: number;
  readonly setHash: string;
}

/** Filter to scope, fingerprint, assign stable ids, apply the rubric, and append to the store. */
export function ingest(file: string, runId: string, doc: EngagementDoc, rubric: Rubric, drafts: readonly FindingDraft[], vulns: VulnContext = NO_VULN_CONTEXT): IngestResult {
  const inScopeDrafts = drafts.filter((d) => inScope(d.file, doc.paths));
  const prints = fingerprintDrafts(inScopeDrafts);
  const store = readStore(file);
  const byFingerprint = new Map(store.findings.map((f) => [f.fingerprint, f]));
  let nextId = store.findings.reduce((max, f) => Math.max(max, Number.parseInt(f.id.slice(2), 10)), 0) + 1;

  const present: Finding[] = [];
  const added: Finding[] = [];
  const updated: Finding[] = [];
  for (const p of stableSort(prints, (x) => x.fingerprint)) {
    const existing = byFingerprint.get(p.fingerprint);
    // Identity (id, fingerprint) is stable; everything else is re-derived every run, because
    // severity depends on the rubric and vulnerability context (both fingerprinted in scope)
    // and locations move with the code.
    const finding: Finding = {
      ...p.draft,
      type: "finding",
      id: existing?.id ?? `F-${String(nextId++).padStart(ID_WIDTH, "0")}`,
      fingerprint: p.fingerprint,
      class: "tool",
      ...rubric.assess(p.draft, vulns),
      rubric_version: rubric.version,
      snippet_hash: p.snippetHash,
    };
    if (existing === undefined) added.push(finding);
    else if (contentHash(existing) !== contentHash(finding)) updated.push(finding);
    present.push(finding);
  }
  const ids = stableSort(present.map((f) => f.id), (id) => id);
  const lines = [...added, ...updated, { type: "run-findings", run_id: runId, finding_ids: ids } satisfies RunFindings].map((r) => `${canonicalJson(r)}\n`);
  appendFileSync(file, lines.join(""));
  return { present, added: added.length, updated: updated.length, outOfScope: drafts.length - inScopeDrafts.length, setHash: findingsSetHash(present) };
}

/**
 * The determinism eval's comparison value (AC18): content of every finding present in a run,
 * excluding run-specific evidence pointers (raw_ref embeds the run id).
 */
export function findingsSetHash(present: readonly Finding[]): string {
  return hash(stableSort(present, (f) => f.id).map((f) => {
    const { raw_ref: _rawRef, ...content } = f;
    return content;
  }));
}

/** Findings observed by the most recent run (empty before the first review). */
export function latestRunFindings(file: string): { runId: string | null; findings: Finding[] } {
  const { findings, runs } = readStore(file);
  const last = runs.at(-1);
  if (last === undefined) return { runId: null, findings: [] };
  const ids = new Set(last.finding_ids);
  return { runId: last.run_id, findings: findings.filter((f) => ids.has(f.id)) };
}

/** Compare findings ignoring the run-specific evidence pointer. */
function contentHash(f: Finding): string {
  const { raw_ref: _rawRef, ...content } = f;
  return hash(content);
}
