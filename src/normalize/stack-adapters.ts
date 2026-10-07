// M3 W5 adapters for the sandboxed per-stack tools. Paths come from inside the sandbox (absolute
// under /tmp/work, or relative to the recipe dir) and are mapped back to repo-relative paths.
// Same contract as the other adapters: pure, golden-tested, ParseError on unexpected output.

import { stableSort } from "../core/determinism.js";
import type { FindingDraft } from "../findings/types.js";
import { ParseError, type SnippetReader } from "./adapters.js";
import { repoRel, type Coverage } from "./sandbox-adapters.js";

export interface StackAdapterInput {
  /** Recipe dir (repo-relative project root). */
  readonly dir: string;
  readonly rawRef: string;
  readonly toolVersion: string;
  readonly snippet: SnippetReader;
}

const base = (lane: string, tool: string, version: string) => ({
  lane, tool, tool_version: version, engine_fingerprint: null, cve: null, aliases: [] as string[], cvss: null,
});

function parseJson(raw: string, tool: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ParseError(`${tool}: output is not valid JSON`);
  }
}
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new ParseError(`${what}: expected an integer`);
  return v;
};
const s = (v: unknown, what: string): string => {
  if (typeof v !== "string") throw new ParseError(`${what}: expected a string`);
  return v;
};
const excerpt = (read: SnippetReader, file: string, line: number): string | null => (line > 0 ? read(file, line, line) : null);
/** Same diagnostic reported twice (per target framework, per package) is one finding. */
function dedupe(drafts: FindingDraft[]): FindingDraft[] {
  const seen = new Set<string>();
  return drafts.filter((d) => {
    const k = `${d.tool}|${d.rule_id}|${d.file}|${String(d.line)}|${d.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** `file:line:col: message` lines (go vet / go build / javac via Gradle). Other lines are context, ignored. */
const FILE_LINE = /^(?:vet: )?(\.?\/?[^\s:][^:]*\.(go)):(\d+):(\d+): (.+)$/;

export function goVetAdapter(log: string, inp: StackAdapterInput): FindingDraft[] {
  const out: FindingDraft[] = [];
  log.split("\n").forEach((line, i) => {
    const m = FILE_LINE.exec(line.trim());
    if (m === null) return;
    const file = repoRel(m[1] ?? "", inp.dir);
    const ln = Number.parseInt(m[3] ?? "0", 10);
    out.push({
      ...base("types", "go-vet", inp.toolVersion), rule_id: "go-vet", category: "quality", file, line: ln, end_line: ln,
      message: m[5] ?? "", tool_severity: "error", snippet: excerpt(inp.snippet, file, ln), raw_ref: `${inp.rawRef}#L${String(i + 1)}`, tags: [],
    });
  });
  return dedupe(out);
}

/** golangci-lint v2 `--output.json.path stdout`: {Issues: [{FromLinter, Text, Pos{Filename, Line}}]}. */
export function golangciAdapter(raw: string, inp: StackAdapterInput): FindingDraft[] {
  const root = parseJson(raw.trim() === "" ? "{}" : raw, "golangci-lint");
  if (!isObj(root)) throw new ParseError("golangci-lint: expected an object");
  const issues = root["Issues"] ?? [];
  if (!Array.isArray(issues)) throw new ParseError("golangci-lint: Issues is not an array");
  return dedupe(issues.map((e, i) => {
    if (!isObj(e) || !isObj(e["Pos"])) throw new ParseError(`golangci-lint Issues[${String(i)}]: unexpected shape`);
    const file = repoRel(s(e["Pos"]["Filename"], "golangci Filename"), inp.dir);
    const line = num(e["Pos"]["Line"], "golangci Line");
    return {
      ...base("lint", "golangci-lint", inp.toolVersion), rule_id: s(e["FromLinter"], "golangci FromLinter"), category: "quality" as const,
      file, line, end_line: line, message: s(e["Text"], "golangci Text"), tool_severity: "issue",
      snippet: excerpt(inp.snippet, file, line), raw_ref: `${inp.rawRef}#/Issues/${String(i)}`, tags: ["lint-mode:baseline"],
    };
  }));
}

/**
 * cargo `--message-format=json`: one JSON object per line; compiler diagnostics have
 * reason "compiler-message". `pick` chooses which diagnostics this lane reports.
 */
export function cargoAdapter(log: string, inp: StackAdapterInput, which: "errors" | "clippy"): FindingDraft[] {
  const out: FindingDraft[] = [];
  log.split("\n").forEach((line, i) => {
    if (!line.startsWith("{")) return; // cargo's own progress/warnings on stderr may be interleaved
    const o = parseJson(line, "cargo");
    if (!isObj(o) || o["reason"] !== "compiler-message" || !isObj(o["message"])) return;
    const msg = o["message"];
    const level = s(msg["level"], "rustc level");
    const code = isObj(msg["code"]) && typeof msg["code"]["code"] === "string" ? msg["code"]["code"] : null;
    const isClippy = code?.startsWith("clippy::") === true;
    if (which === "errors" ? level !== "error" : !isClippy) return;
    const spans = Array.isArray(msg["spans"]) ? msg["spans"].filter(isObj) : [];
    const primary = spans.find((sp) => sp["is_primary"] === true) ?? spans[0];
    if (primary === undefined) return; // crate-level diagnostics without a location (e.g. "aborting")
    const file = repoRel(s(primary["file_name"], "rustc file_name"), inp.dir);
    const start = num(primary["line_start"], "rustc line_start");
    out.push({
      ...base(which === "errors" ? "types" : "lint", which === "errors" ? "rustc" : "clippy", inp.toolVersion),
      rule_id: code ?? "rustc-error", category: "quality", file, line: start, end_line: num(primary["line_end"], "rustc line_end"),
      message: s(msg["message"], "rustc message"), tool_severity: level, snippet: excerpt(inp.snippet, file, start),
      raw_ref: `${inp.rawRef}#L${String(i + 1)}`, tags: which === "clippy" ? ["lint-mode:baseline"] : [],
    });
  });
  return dedupe(out);
}

/** javac via Maven (`[ERROR] /path/X.java:[12,5] msg`), javac via Gradle (`/path/X.java:12: error: msg`), kotlinc (`e: file:///path/X.kt:12:5 msg`). */
const MAVEN_ERR = /^\[ERROR\] (\/\S+\.(?:java|kt)):\[(\d+),\d+\] (.+)$/;
const JAVAC_ERR = /^(\/\S+\.java):(\d+): error: (.+)$/;
const KOTLIN_ERR = /^e: (?:file:\/\/)?(\/\S+\.kts?):(\d+):\d+ (.+)$/;

export function jvmCompileAdapter(log: string, inp: StackAdapterInput): FindingDraft[] {
  const out: FindingDraft[] = [];
  log.split("\n").forEach((line, i) => {
    const t = line.trim();
    const m = MAVEN_ERR.exec(t) ?? JAVAC_ERR.exec(t) ?? KOTLIN_ERR.exec(t);
    if (m === null) return;
    const file = repoRel(m[1] ?? "", inp.dir);
    const ln = Number.parseInt(m[2] ?? "0", 10);
    out.push({
      ...base("types", "javac", inp.toolVersion), rule_id: "compile-error", category: "quality", file, line: ln, end_line: ln,
      message: m[3] ?? "", tool_severity: "error", snippet: excerpt(inp.snippet, file, ln), raw_ref: `${inp.rawRef}#L${String(i + 1)}`, tags: [],
    });
  });
  return dedupe(out);
}

/** PMD 7 `-f json`: {files: [{filename, violations: [{beginline, endline, rule, ruleset, priority, description}]}]}. */
export function pmdAdapter(raw: string, inp: StackAdapterInput): FindingDraft[] {
  const root = parseJson(raw, "pmd");
  if (!isObj(root) || !Array.isArray(root["files"])) throw new ParseError("pmd: expected {files: [...]}");
  const out: FindingDraft[] = [];
  root["files"].forEach((f, fi) => {
    if (!isObj(f) || !Array.isArray(f["violations"])) throw new ParseError(`pmd files[${String(fi)}]: unexpected shape`);
    const file = repoRel(s(f["filename"], "pmd filename"), inp.dir);
    f["violations"].forEach((v, vi) => {
      if (!isObj(v)) throw new ParseError("pmd violation: expected an object");
      const line = num(v["beginline"], "pmd beginline");
      out.push({
        ...base("lint", "pmd", inp.toolVersion), rule_id: s(v["rule"], "pmd rule"), category: "quality", file, line, end_line: num(v["endline"], "pmd endline"),
        message: s(v["description"], "pmd description").trim(), tool_severity: String(num(v["priority"], "pmd priority")),
        snippet: excerpt(inp.snippet, file, line), raw_ref: `${inp.rawRef}#/files/${String(fi)}/violations/${String(vi)}`,
        tags: ["lint-mode:baseline", `ruleset:${s(v["ruleset"], "pmd ruleset")}`],
      });
    });
  });
  return out;
}

/** PHPStan `--error-format=json`: {files: {path: {messages: [{message, line, identifier?}]}}, errors: []}. */
export function phpstanAdapter(raw: string, inp: StackAdapterInput): FindingDraft[] {
  const root = parseJson(raw, "phpstan");
  if (!isObj(root) || !isObj(root["files"])) throw new ParseError("phpstan: expected {files: {...}}");
  const out: FindingDraft[] = [];
  for (const [p, f] of stableSort(Object.entries(root["files"]), ([k]) => k)) {
    if (!isObj(f) || !Array.isArray(f["messages"])) throw new ParseError(`phpstan ${p}: unexpected shape`);
    const file = repoRel(p, inp.dir);
    f["messages"].forEach((m, i) => {
      if (!isObj(m)) throw new ParseError("phpstan message: expected an object");
      const line = typeof m["line"] === "number" ? num(m["line"], "phpstan line") : 0;
      out.push({
        ...base("types", "phpstan", inp.toolVersion), rule_id: typeof m["identifier"] === "string" ? m["identifier"] : "phpstan",
        category: "quality", file, line, end_line: line, message: s(m["message"], "phpstan message"), tool_severity: "error",
        snippet: excerpt(inp.snippet, file, line), raw_ref: `${inp.rawRef}#/files/${encodeURIComponent(p)}/messages/${String(i)}`, tags: [],
      });
    });
  }
  return out;
}

/** RuboCop `--format json`: {files: [{path, offenses: [{severity, message, cop_name, location{start_line, last_line}}]}]}. */
export function rubocopAdapter(raw: string, inp: StackAdapterInput): FindingDraft[] {
  const root = parseJson(raw, "rubocop");
  if (!isObj(root) || !Array.isArray(root["files"])) throw new ParseError("rubocop: expected {files: [...]}");
  const out: FindingDraft[] = [];
  root["files"].forEach((f, fi) => {
    if (!isObj(f) || !Array.isArray(f["offenses"])) throw new ParseError(`rubocop files[${String(fi)}]: unexpected shape`);
    const file = repoRel(s(f["path"], "rubocop path"), inp.dir);
    f["offenses"].forEach((o, oi) => {
      if (!isObj(o) || !isObj(o["location"])) throw new ParseError("rubocop offense: unexpected shape");
      const line = num(o["location"]["start_line"], "rubocop start_line");
      const cop = s(o["cop_name"], "rubocop cop_name");
      out.push({
        ...base("lint", "rubocop", inp.toolVersion), rule_id: cop, category: cop.startsWith("Security/") ? "security" : "quality",
        file, line, end_line: num(o["location"]["last_line"], "rubocop last_line"),
        message: s(o["message"], "rubocop message").replace(new RegExp(`^${cop.replace("/", "\\/")}: `), ""),
        tool_severity: s(o["severity"], "rubocop severity"), snippet: excerpt(inp.snippet, file, line),
        raw_ref: `${inp.rawRef}#/files/${String(fi)}/offenses/${String(oi)}`, tags: ["lint-mode:baseline"],
      });
    });
  });
  return out;
}

/** MSBuild diagnostics: `/path/File.cs(12,5): error CS0029: message [/path/App.csproj]`. */
const MSBUILD = /^(\/\S+?\.(?:cs|fs|vb|razor|cshtml))\((\d+),\d+\): (error|warning) ([A-Z]+\d+): (.+?)(?: \[\/\S+\])?$/;

export function msbuildAdapter(log: string, inp: StackAdapterInput, which: "errors" | "analyzers"): FindingDraft[] {
  const out: FindingDraft[] = [];
  log.split("\n").forEach((line, i) => {
    const m = MSBUILD.exec(line.trim());
    if (m === null) return;
    const [level, code] = [m[3] ?? "", m[4] ?? ""];
    if (which === "errors" ? level !== "error" : !code.startsWith("CA")) return;
    const file = repoRel(m[1] ?? "", inp.dir);
    const ln = Number.parseInt(m[2] ?? "0", 10);
    out.push({
      ...base(which === "errors" ? "types" : "lint", which === "errors" ? "dotnet-build" : "dotnet-analyzers", inp.toolVersion),
      rule_id: code, category: which === "analyzers" && /^CA(2100|3\d{3}|5\d{3})$/.test(code) ? "security" : "quality",
      file, line: ln, end_line: ln, message: m[5] ?? "", tool_severity: level, snippet: excerpt(inp.snippet, file, ln),
      raw_ref: `${inp.rawRef}#L${String(i + 1)}`, tags: which === "analyzers" ? ["lint-mode:baseline"] : [],
    });
  });
  return dedupe(out);
}

/**
 * Go cover profile (`go test -coverprofile`): `mode: X` then `importpath/file.go:l.c,l.c stmts count`.
 * Import paths map to repo files through the module path from go.mod. Go measures STATEMENTS:
 * they fill the lines_* fields (the report labels Go coverage as statement coverage).
 */
export function goCoverAdapter(profile: string, modulePath: string, dir: string): Coverage {
  const lines = profile.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return { files: {}, totals: { lines_found: 0, lines_hit: 0, branches_found: 0, branches_hit: 0 } };
  if (!(lines[0] ?? "").startsWith("mode: ")) throw new ParseError("go cover profile: missing mode line");
  // Blocks can repeat (one entry per test binary): a block is hit if any entry hit it.
  const blocks = new Map<string, { file: string; stmts: number; hit: boolean }>();
  for (const l of lines.slice(1)) {
    const m = /^(.+\.go):(\d+\.\d+,\d+\.\d+) (\d+) (\d+)$/.exec(l.trim());
    if (m === null) throw new ParseError(`go cover profile: unexpected line "${l.slice(0, 80)}"`);
    const imp = m[1] ?? "";
    const rel = imp.startsWith(`${modulePath}/`) ? imp.slice(modulePath.length + 1) : imp;
    const file = repoRel(rel, dir);
    const key = `${file}:${m[2] ?? ""}`;
    const prev = blocks.get(key);
    const hit = Number.parseInt(m[4] ?? "0", 10) > 0;
    blocks.set(key, { file, stmts: Number.parseInt(m[3] ?? "0", 10), hit: hit || (prev?.hit ?? false) });
  }
  const files: Record<string, { lines_found: number; lines_hit: number; branches_found: number; branches_hit: number }> = {};
  for (const b of blocks.values()) {
    const f = files[b.file] ?? { lines_found: 0, lines_hit: 0, branches_found: 0, branches_hit: 0 };
    f.lines_found += b.stmts;
    if (b.hit) f.lines_hit += b.stmts;
    files[b.file] = f;
  }
  const sorted: Record<string, { lines_found: number; lines_hit: number; branches_found: number; branches_hit: number }> = {};
  const totals = { lines_found: 0, lines_hit: 0, branches_found: 0, branches_hit: 0 };
  for (const k of stableSort(Object.keys(files), (x) => x)) {
    const f = files[k];
    if (f === undefined) continue;
    sorted[k] = f;
    totals.lines_found += f.lines_found;
    totals.lines_hit += f.lines_hit;
  }
  return { files: sorted, totals };
}

/** The module path declared in go.mod. */
export function goModulePath(goMod: string): string {
  const m = /^module\s+(\S+)/m.exec(goMod);
  if (m?.[1] === undefined) throw new ParseError("go.mod declares no module path");
  return m[1].replace(/^"|"$/g, "");
}
