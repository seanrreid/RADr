// Adapters for sandboxed tools (M2 W3): tsc (text), mypy (JSON lines), LCOV coverage.
// Paths inside the sandbox are under /tmp/work/<recipe dir>/ and are mapped back to
// repo-relative POSIX paths. Unknown shapes throw ParseError; nothing is guessed.

import { normalizePath, stableSort } from "../core/determinism.js";
import type { FindingDraft } from "../findings/types.js";
import { ParseError, type SnippetReader } from "./adapters.js";

/** Sandbox source root: the recipe dir under the copied tree. */
export function sandboxRoot(dir: string): string {
  return dir === "." || dir === "" ? "/tmp/work" : `/tmp/work/${dir}`;
}

/** Map a tool path (absolute in-sandbox, or relative to the recipe dir) to a repo-relative path. */
export function repoRel(p: string, dir: string): string {
  const abs = p.startsWith("/") ? p : `${sandboxRoot(dir)}/${p}`;
  try {
    return normalizePath(abs, "/tmp/work");
  } catch (e) {
    throw new ParseError(e instanceof Error ? e.message : String(e));
  }
}

const base = (lane: string, tool: string, version: string) => ({
  lane, tool, tool_version: version, engine_fingerprint: null, cve: null, aliases: [] as string[], cvss: null, tags: [] as string[],
});

const TSC_LINE = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;

/** `tsc --pretty false` output: one diagnostic per line; continuation lines are indented. */
export function tscAdapter(text: string, opts: { dir: string; rawRef: string; toolVersion: string; snippet: SnippetReader }): FindingDraft[] {
  const out: FindingDraft[] = [];
  text.split("\n").forEach((line, i) => {
    const m = TSC_LINE.exec(line);
    if (m === null) return; // summary, blank, and indented continuation lines
    const file = repoRel(m[1] ?? "", opts.dir);
    const ln = Number.parseInt(m[2] ?? "0", 10);
    out.push({
      ...base("types", "tsc", opts.toolVersion),
      rule_id: m[5] ?? "", category: "quality", file, line: ln, end_line: ln,
      message: m[6] ?? "", tool_severity: m[4] ?? "", snippet: opts.snippet(file, ln, ln), raw_ref: `${opts.rawRef}#L${i + 1}`,
    });
  });
  return out;
}

/** `mypy -O json`: one JSON object per line. */
export function mypyAdapter(text: string, opts: { dir: string; rawRef: string; toolVersion: string; snippet: SnippetReader }): FindingDraft[] {
  const out: FindingDraft[] = [];
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "" || !line.trimStart().startsWith("{")) return;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new ParseError(`mypy line ${i + 1}: not JSON`);
    }
    const file = repoRel(String(d["file"]), opts.dir);
    const ln = typeof d["line"] === "number" && Number.isSafeInteger(d["line"]) ? d["line"] : 0;
    const severity = d["severity"];
    if (severity !== "error" && severity !== "note") throw new ParseError(`mypy line ${i + 1}: unexpected severity`);
    out.push({
      ...base("types", "mypy", opts.toolVersion),
      rule_id: typeof d["code"] === "string" ? d["code"] : "misc", category: "quality", file, line: ln, end_line: ln,
      message: String(d["message"]), tool_severity: severity, snippet: opts.snippet(file, ln, ln), raw_ref: `${opts.rawRef}#L${i + 1}`,
    });
  });
  return out;
}

export interface FileCoverage {
  readonly lines_found: number;
  readonly lines_hit: number;
  readonly branches_found: number;
  readonly branches_hit: number;
}

export interface Coverage {
  readonly files: Readonly<Record<string, FileCoverage>>;
  readonly totals: FileCoverage;
}

/** LCOV tracefile → per-file and total line/branch counts (integers; repo-relative paths). */
export function parseLcov(text: string, dir: string): Coverage {
  const files: Record<string, FileCoverage> = {};
  let current: string | undefined;
  let acc = { lines_found: 0, lines_hit: 0, branches_found: 0, branches_hit: 0 };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      current = repoRel(line.slice(3), dir);
      acc = { lines_found: 0, lines_hit: 0, branches_found: 0, branches_hit: 0 };
    } else if (current !== undefined && /^(LF|LH|BRF|BRH):\d+$/.test(line)) {
      const [k, v] = line.split(":");
      const n = Number.parseInt(v ?? "0", 10);
      if (k === "LF") acc.lines_found = n;
      else if (k === "LH") acc.lines_hit = n;
      else if (k === "BRF") acc.branches_found = n;
      else acc.branches_hit = n;
    } else if (line === "end_of_record") {
      if (current === undefined) throw new ParseError("lcov: end_of_record without SF");
      if (!current.split("/").includes("node_modules")) files[current] = acc; // deps at any depth
      current = undefined;
    }
  }
  const sorted: Record<string, FileCoverage> = {};
  const totals = { lines_found: 0, lines_hit: 0, branches_found: 0, branches_hit: 0 };
  for (const f of stableSort(Object.keys(files), (x) => x)) {
    const c = files[f] as FileCoverage;
    sorted[f] = c;
    totals.lines_found += c.lines_found;
    totals.lines_hit += c.lines_hit;
    totals.branches_found += c.branches_found;
    totals.branches_hit += c.branches_hit;
  }
  return { files: sorted, totals };
}

export const pct = (hit: number, found: number): number | null => (found === 0 ? null : Math.floor((hit * 100) / found));
