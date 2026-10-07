// Tool adapters (T5.1): pure functions from a tool's raw output to FindingDrafts. Each one is
// golden-tested against fixed raw input (test/golden/<tool>/). An adapter that sees output it
// doesn't understand throws ParseError → lane outcome `parse-error`; it never guesses.

import { DeterminismError, normalizePath, stableSort } from "../core/determinism.js";
import type { FindingDraft } from "../findings/types.js";

export class ParseError extends Error {
  override readonly name = "ParseError";
}

/** Reads lines [start..end] (1-based, inclusive) of a repo-relative file, or null if unavailable. */
export type SnippetReader = (file: string, start: number, end: number) => string | null;

interface AdapterInput {
  readonly raw: string;
  readonly rawRef: string;
  readonly repoRoot: string;
  readonly toolVersion: string;
  readonly snippet: SnippetReader;
}

const MAX_SNIPPET_LINES = 10;

function parseJson(raw: string, tool: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ParseError(`${tool}: output is not valid JSON`);
  }
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new ParseError(`${what}: expected an object`);
  return v as Record<string, unknown>;
}

function arr(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new ParseError(`${what}: expected an array`);
  return v;
}

function str(v: unknown, what: string): string {
  if (typeof v !== "string") throw new ParseError(`${what}: expected a string`);
  return v;
}

function int(v: unknown, what: string, fallback?: number): number {
  if (v === undefined || v === null) {
    if (fallback !== undefined) return fallback;
    throw new ParseError(`${what}: missing`);
  }
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new ParseError(`${what}: expected an integer`);
  return v;
}

/** A tool reporting a path outside the repo is unexpected output, not a crash. */
function repoPath(p: string, repoRoot: string): string {
  try {
    return normalizePath(p, repoRoot);
  } catch (e) {
    if (e instanceof DeterminismError) throw new ParseError(e.message);
    throw e;
  }
}

/** First sentence (≤ 160 chars) of an advisory's details, for advisories without a summary. */
function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
  return sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence;
}

function excerpt(read: SnippetReader, file: string, line: number, end: number): string | null {
  if (line < 1) return null;
  return read(file, line, Math.min(Math.max(end, line), line + MAX_SNIPPET_LINES - 1));
}

const base = (lane: string, tool: string, version: string) => ({
  lane, tool, tool_version: version, engine_fingerprint: null, cve: null, aliases: [] as string[], cvss: null,
});

/** ESLint `--format json` (array of {filePath, messages[]}). */
export function eslintAdapter(input: AdapterInput): FindingDraft[] {
  const out: FindingDraft[] = [];
  arr(parseJson(input.raw, "eslint"), "eslint").forEach((fileEntry, fi) => {
    const f = obj(fileEntry, `eslint[${fi}]`);
    const file = repoPath(str(f["filePath"], `eslint[${fi}].filePath`), input.repoRoot);
    arr(f["messages"], `eslint[${fi}].messages`).forEach((msgEntry, mi) => {
      const m = obj(msgEntry, `eslint[${fi}].messages[${mi}]`);
      const fatal = m["fatal"] === true;
      const line = int(m["line"], "eslint line", 1);
      const end = int(m["endLine"], "eslint endLine", line);
      out.push({
        ...base("lint", "eslint", input.toolVersion),
        rule_id: fatal ? "parse-error" : str(m["ruleId"], "eslint ruleId"),
        category: "quality",
        file, line, end_line: end,
        message: str(m["message"], "eslint message"),
        tool_severity: fatal ? "fatal" : String(int(m["severity"], "eslint severity")),
        snippet: excerpt(input.snippet, file, line, end),
        raw_ref: `${input.rawRef}#/${fi}/messages/${mi}`,
        tags: ["lint-mode:baseline"],
      });
    });
  });
  return out;
}

/** ruff `--output-format json` (array of diagnostics). ruff has no severity: every diagnostic is "error". */
export function ruffAdapter(input: AdapterInput): FindingDraft[] {
  return arr(parseJson(input.raw, "ruff"), "ruff").map((entry, i) => {
    const d = obj(entry, `ruff[${i}]`);
    const loc = obj(d["location"], `ruff[${i}].location`);
    const endLoc = d["end_location"] === undefined || d["end_location"] === null ? loc : obj(d["end_location"], `ruff[${i}].end_location`);
    const file = repoPath(str(d["filename"], `ruff[${i}].filename`), input.repoRoot);
    const line = int(loc["row"], "ruff row");
    const end = int(endLoc["row"], "ruff end row", line);
    const code = d["code"];
    return {
      ...base("lint", "ruff", input.toolVersion),
      rule_id: typeof code === "string" ? code : "syntax-error",
      category: "quality" as const,
      file, line, end_line: end,
      message: str(d["message"], `ruff[${i}].message`),
      tool_severity: "error",
      snippet: excerpt(input.snippet, file, line, end),
      raw_ref: `${input.rawRef}#/${i}`,
      tags: ["lint-mode:baseline"],
    };
  });
}

/**
 * gitleaks `--report-format json` produced WITH --redact. Snippets are never captured for
 * secrets. Commit author name/email in the report are deliberately not copied into findings.
 */
export function gitleaksAdapter(input: AdapterInput & { readonly presentAtHead: (file: string) => boolean }): FindingDraft[] {
  return arr(parseJson(input.raw, "gitleaks"), "gitleaks").map((entry, i) => {
    const g = obj(entry, `gitleaks[${i}]`);
    const secret = str(g["Secret"], `gitleaks[${i}].Secret`);
    if (secret !== "REDACTED") throw new ParseError(`gitleaks[${i}]: secret is not redacted (refusing to persist it)`);
    const file = repoPath(str(g["File"], `gitleaks[${i}].File`), input.repoRoot);
    const commit = str(g["Commit"], `gitleaks[${i}].Commit`);
    const line = int(g["StartLine"], "gitleaks StartLine");
    return {
      ...base("secrets", "gitleaks", input.toolVersion),
      rule_id: str(g["RuleID"], `gitleaks[${i}].RuleID`),
      category: "secrets" as const,
      file, line, end_line: int(g["EndLine"], "gitleaks EndLine", line),
      message: `${str(g["Description"], `gitleaks[${i}].Description`)} (introduced in commit ${commit.slice(0, 12)})`,
      tool_severity: "secret",
      snippet: null,
      engine_fingerprint: str(g["Fingerprint"], `gitleaks[${i}].Fingerprint`),
      raw_ref: `${input.rawRef}#/${i}`,
      tags: [`commit:${commit}`, input.presentAtHead(file) ? "present-at-head" : "history-only"],
    };
  });
}

/** osv-scanner `--format json`: one finding per (source, package, advisory group). */
export function osvAdapter(input: AdapterInput): FindingDraft[] {
  const out: FindingDraft[] = [];
  const root = obj(parseJson(input.raw, "osv-scanner"), "osv-scanner");
  const results = root["results"] === null || root["results"] === undefined ? [] : arr(root["results"], "osv.results");
  results.forEach((resEntry, ri) => {
    const res = obj(resEntry, `osv.results[${ri}]`);
    const source = obj(res["source"], `osv.results[${ri}].source`);
    const file = repoPath(str(source["path"], "osv source.path"), input.repoRoot);
    arr(res["packages"], `osv.results[${ri}].packages`).forEach((pkgEntry, pi) => {
      const p = obj(pkgEntry, `osv.results[${ri}].packages[${pi}]`);
      const pkg = obj(p["package"], "osv package");
      const [eco, name, version] = [str(pkg["ecosystem"], "ecosystem"), str(pkg["name"], "name"), str(pkg["version"], "version")];
      const vulns = arr(p["vulnerabilities"], "osv vulnerabilities").map((v, vi) => obj(v, `osv vulnerability ${vi}`));
      arr(p["groups"], "osv groups").forEach((groupEntry, gi) => {
        const group = obj(groupEntry, `osv group ${gi}`);
        const ids = stableSort(arr(group["ids"], "osv group ids").map((x) => str(x, "osv id")), (x) => x);
        const primary = ids[0];
        if (primary === undefined) throw new ParseError("osv group with no ids");
        const members = vulns.filter((v) => ids.includes(str(v["id"], "osv vuln id")));
        const aliasSet = new Set<string>(ids);
        for (const v of members) for (const a of Array.isArray(v["aliases"]) ? v["aliases"] : []) if (typeof a === "string") aliasSet.add(a);
        const aliases = stableSort([...aliasSet], (x) => x);
        const summary =
          members.map((v) => (typeof v["summary"] === "string" ? v["summary"].trim() : "")).find((s) => s !== "") ??
          members.map((v) => (typeof v["details"] === "string" ? firstSentence(v["details"]) : "")).find((s) => s !== "") ??
          "known vulnerability";
        const maxSev = typeof group["max_severity"] === "string" && group["max_severity"] !== "" ? group["max_severity"] : null;
        if (maxSev !== null && !/^\d{1,2}(\.\d)?$/.test(maxSev)) throw new ParseError(`osv: unexpected max_severity "${maxSev}"`);
        out.push({
          ...base("sca", "osv-scanner", input.toolVersion),
          rule_id: primary,
          category: "dependency",
          file, line: 0, end_line: 0,
          message: `${eco} ${name}@${version}: ${summary}`,
          tool_severity: maxSev === null ? "unscored" : "cvss",
          snippet: null,
          engine_fingerprint: `${eco}:${name}:${version}:${primary}:${file}`,
          cve: aliases.find((a) => a.startsWith("CVE-")) ?? null,
          aliases,
          cvss: maxSev,
          raw_ref: `${input.rawRef}#/results/${ri}/packages/${pi}/groups/${gi}`,
          tags: [`ecosystem:${eco}`, `package:${name}@${version}`],
        });
      });
    });
  });
  return out;
}

/** scc `--format json`: per-language integer metrics (census; no findings). */
export function sccMetrics(raw: string): Record<string, unknown> {
  const langs = arr(parseJson(raw, "scc"), "scc").map((e, i) => obj(e, `scc[${i}]`));
  const languages: Record<string, unknown> = {};
  const totals = { files: 0, lines: 0, code: 0, comment: 0, blank: 0, complexity: 0 };
  for (const l of langs) {
    const row = {
      files: int(l["Count"], "scc Count"), lines: int(l["Lines"], "scc Lines"), code: int(l["Code"], "scc Code"),
      comment: int(l["Comment"], "scc Comment"), blank: int(l["Blank"], "scc Blank"), complexity: int(l["Complexity"], "scc Complexity"),
    };
    languages[str(l["Name"], "scc Name")] = row;
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += row[k];
  }
  return { languages, totals };
}
