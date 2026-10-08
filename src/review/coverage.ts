// What a run could NOT assess (PRD P8 "no silent partials"; dogfood 2026-10-08). A lane that runs
// and finds nothing is only meaningful if it looked: no lockfile means no dependency scan, no
// linter for a language means no lint, a language without SAST rules was never scanned. These
// gaps are computed from the lanes' own metrics and the census, recorded as run notes, shown in
// the report, and turn the matching scorecard rows grey instead of green.

import { matchesAny } from "../core/glob.js";
import type { EngagementDoc } from "../engagement/config.js";

/** scc language → radr stack. Code in a language not listed here isn't supported by any stack. */
export const LANGUAGE_STACK: Readonly<Record<string, string>> = {
  TypeScript: "typescript-javascript", "TypeScript Typings": "typescript-javascript", JavaScript: "typescript-javascript",
  TSX: "typescript-javascript", JSX: "typescript-javascript", Vue: "typescript-javascript", Svelte: "typescript-javascript",
  Python: "python", Go: "go", Rust: "rust", Java: "java-kotlin", Kotlin: "java-kotlin", PHP: "php", Ruby: "ruby", "C#": "csharp",
};

/** Program-source languages (as in the tests lane); data, docs and config don't count. */
export const CODE_LANGUAGES: ReadonlySet<string> = new Set([...Object.keys(LANGUAGE_STACK), "Scala", "Swift", "C", "C++", "C Header", "C++ Header"]);

/** Lockfiles osv-scanner reads offline without resolution, per stack (basenames, as globs). */
export const STACK_LOCKFILES: Readonly<Record<string, readonly string[]>> = {
  "typescript-javascript": ["**/package-lock.json", "**/npm-shrinkwrap.json", "**/yarn.lock", "**/pnpm-lock.yaml", "**/bun.lock"],
  python: ["**/requirements*.txt", "**/Pipfile.lock", "**/poetry.lock", "**/pdm.lock", "**/uv.lock"],
  go: ["**/go.mod"],
  rust: ["**/Cargo.lock"],
  "java-kotlin": ["**/pom.xml", "**/gradle.lockfile", "**/buildscript-gradle.lockfile", "**/gradle/verification-metadata.xml"],
  php: ["**/composer.lock"],
  ruby: ["**/Gemfile.lock", "**/gems.locked"],
  csharp: ["**/packages.lock.json"],
};

/** Languages each stack's baseline linters actually lint (PMD: Java, not Kotlin). */
export const LINTED_LANGUAGES: Readonly<Record<string, readonly string[]>> = {
  "typescript-javascript": ["TypeScript", "TypeScript Typings", "JavaScript", "TSX", "JSX"],
  python: ["Python"], go: ["Go"], rust: ["Rust"], "java-kotlin": ["Java"], php: ["PHP"], ruby: ["Ruby"], csharp: ["C#"],
};

/** Client-facing stack names. */
export const STACK_LABEL: Readonly<Record<string, string>> = {
  "typescript-javascript": "TypeScript/JavaScript", python: "Python", go: "Go", rust: "Rust", "java-kotlin": "Java/Kotlin", php: "PHP", ruby: "Ruby", csharp: ".NET",
};

/** Lockfiles in a file list (sca lane metric). */
export function lockfiles(files: readonly string[]): string[] {
  const all = Object.values(STACK_LOCKFILES).flat();
  return files.filter((f) => !f.split("/").includes("node_modules") && matchesAny(f, all));
}

interface CensusFile { readonly code: number; readonly language: string }
type Metrics = Readonly<Record<string, Readonly<Record<string, unknown>> | undefined>>;

const pct = (n: number, total: number) => (total === 0 ? 0 : Math.floor((n * 100) / total));

/** Lines of code per language, from the census (code languages only). */
function codeByLanguage(metrics: Metrics): Map<string, { files: number; code: number }> {
  const files = (metrics["census"]?.["files"] ?? {}) as Readonly<Record<string, CensusFile>>;
  const out = new Map<string, { files: number; code: number }>();
  for (const f of Object.values(files)) {
    if (!CODE_LANGUAGES.has(f.language)) continue;
    const a = out.get(f.language) ?? { files: 0, code: 0 };
    out.set(f.language, { files: a.files + 1, code: a.code + f.code });
  }
  return out;
}

export function coverageGaps(doc: Pick<EngagementDoc, "stacks" | "lanes">, metrics: Metrics): string[] {
  const code = codeByLanguage(metrics);
  const total = [...code.values()].reduce((n, x) => n + x.code, 0);
  const langs = [...code.keys()].sort();
  const share = (l: string) => `${String(code.get(l)?.code ?? 0)} lines, ${String(pct(code.get(l)?.code ?? 0, total))}% of the code`;
  const gaps: string[] = [];

  const unsupported = langs.filter((l) => LANGUAGE_STACK[l] === undefined);
  for (const l of unsupported) gaps.push(`${l} (${share(l)}) isn't a supported stack: no lint, type, dependency or SAST analysis covered it (secrets, complexity, duplication and history did)`);

  const lockfileList = metrics["sca"]?.["lockfiles"];
  if (doc.lanes.includes("sca") && Array.isArray(lockfileList)) {
    const found = lockfileList.map(String);
    for (const s of doc.stacks) {
      const globs = STACK_LOCKFILES[s] ?? [];
      if (!found.some((f) => matchesAny(f, globs))) gaps.push(`Dependencies (${STACK_LABEL[s] ?? s}): no lockfile the scanner can read, so dependency vulnerabilities were not assessed${s === "java-kotlin" ? " (Gradle builds need a gradle.lockfile; version catalogs aren't resolved offline)" : ""}`);
    }
  }

  const lint = metrics["lint"];
  if (doc.lanes.includes("lint") && lint !== undefined && Array.isArray(lint["linted"])) {
    const linted = new Set((lint["linted"] as unknown[]).flatMap((s) => LINTED_LANGUAGES[String(s)] ?? []));
    const why = new Map(((lint["skipped"] ?? []) as { stack: string; why: string }[]).map((x) => [x.stack, x.why]));
    for (const l of langs.filter((x) => LANGUAGE_STACK[x] !== undefined && !linted.has(x))) {
      const stack = LANGUAGE_STACK[l] ?? "";
      const reason = why.get(stack) ?? (stack === "java-kotlin" && l === "Kotlin" ? "radr has no Kotlin linter yet (PMD lints Java)" : "no linter ran for it");
      gaps.push(`Lint (${l}, ${share(l)}): not linted: ${reason}`);
    }
  }

  const sast = metrics["sast"]?.["languages"] as Readonly<Record<string, { files: number; scanned: number }>> | undefined;
  if (doc.lanes.includes("sast") && sast !== undefined) {
    for (const l of langs.filter((x) => LANGUAGE_STACK[x] !== undefined && (sast[x]?.scanned ?? 0) === 0)) gaps.push(`SAST (${l}, ${share(l)}): no file was scanned`);
  }
  const partial = metrics["sast"]?.["partial_parse"];
  if (Array.isArray(partial) && partial.length > 0) gaps.push(`SAST parsed ${String(partial.length)} file(s) only partly (syntax the engine doesn't know), so rules may have missed code in: ${partial.map(String).join(", ")}`);
  return gaps;
}

/**
 * sast lane metric: per census language, how many files there are and how many Opengrep
 * scanned; and files it parsed only partly. Without `paths.scanned` in the output (older
 * engines, fixtures), coverage is unknown and nothing is claimed.
 */
export function sastCoverage(raw: string, census: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  let doc: { paths?: { scanned?: unknown }; errors?: unknown };
  try {
    doc = JSON.parse(raw) as typeof doc;
  } catch {
    return {};
  }
  const out: Record<string, unknown> = {};
  const partial = (Array.isArray(doc.errors) ? doc.errors : [])
    .filter((e): e is { type: unknown; path: unknown } => {
      if (typeof e !== "object" || e === null) return false;
      const t = (e as { type?: unknown }).type; // "PartialParsing" or ["PartialParsing", spans]
      return t === "PartialParsing" || (Array.isArray(t) && t[0] === "PartialParsing");
    })
    .map((e) => String(e.path)).filter((p) => p !== "undefined");
  if (partial.length > 0) out["partial_parse"] = [...new Set(partial)].sort();
  const scanned = doc.paths?.scanned;
  const files = (census?.["files"] ?? undefined) as Readonly<Record<string, CensusFile>> | undefined;
  if (!Array.isArray(scanned) || files === undefined) return out;
  const seen = new Set(scanned.map(String));
  const languages: Record<string, { files: number; scanned: number }> = {};
  for (const [file, f] of Object.entries(files)) {
    if (!CODE_LANGUAGES.has(f.language)) continue;
    const a = languages[f.language] ?? { files: 0, scanned: 0 };
    languages[f.language] = { files: a.files + 1, scanned: a.scanned + (seen.has(file) ? 1 : 0) };
  }
  out["languages"] = languages;
  return out;
}

