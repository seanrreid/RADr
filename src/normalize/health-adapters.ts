// M3 health-lane adapters: maint (lizard, jscpd), iac (Checkov, hadolint), license (ScanCode,
// syft SBOM), hygiene (Scorecard). Same contract as adapters.ts: pure, golden-tested, and a
// ParseError on output they don't understand. Metrics are integers only.

import { stableSort } from "../core/determinism.js";
import type { FindingDraft } from "../findings/types.js";
import type { LicenseClass } from "../rubric/rubric.js";
import { ParseError, type AdapterInput, arr, int, obj, parseJson, repoPath, str, excerpt } from "./adapters.js";

const base = (lane: string, tool: string, version: string) => ({
  lane, tool, tool_version: version, engine_fingerprint: null, cve: null, aliases: [] as string[], cvss: null,
});

const pct = (part: number, whole: number): number => (whole > 0 ? Math.floor((part * 100) / whole) : 0);

// --- maint: lizard ------------------------------------------------------------------------------

/** Functions above this cyclomatic complexity are findings (and count toward the scorecard %). */
export const CCN_COMPLEX = 15;
export const CCN_VERY_COMPLEX = 30;

/** RFC 4180 fields of one CSV line (lizard quotes fields containing commas; "" escapes a quote). */
export function csvFields(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  if (quoted) throw new ParseError("lizard: unterminated quoted CSV field");
  out.push(cur);
  return out;
}

export interface LizardMetrics {
  readonly [key: string]: unknown;
  readonly functions: number;
  readonly complex_functions: number;
  readonly complex_functions_pct: number;
}

/** `lizard --csv` (no header): NLOC,CCN,token,PARAM,length,location,file,function,long_name,start,end. */
export function lizardAdapter(input: AdapterInput): { findings: FindingDraft[]; metrics: LizardMetrics } {
  const findings: FindingDraft[] = [];
  let functions = 0;
  let complex = 0;
  input.raw.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    const f = csvFields(line.replace(/\r$/, ""));
    if (f.length !== 11) throw new ParseError(`lizard line ${i + 1}: expected 11 CSV fields, got ${f.length}`);
    const n = (k: number, what: string): number => {
      const v = f[k] ?? "";
      if (!/^\d+$/.test(v)) throw new ParseError(`lizard line ${i + 1}: ${what} "${v}" is not an integer`);
      return Number.parseInt(v, 10);
    };
    const [nloc, ccn, start, end] = [n(0, "NLOC"), n(1, "CCN"), n(9, "start"), n(10, "end")];
    functions++;
    if (ccn <= CCN_COMPLEX) return;
    complex++;
    const file = repoPath(f[6] ?? "", input.repoRoot);
    const name = f[7] ?? "";
    findings.push({
      ...base("maint", "lizard", input.toolVersion),
      rule_id: "cyclomatic-complexity",
      category: "maintainability",
      file, line: start, end_line: end,
      message: `Function ${name} has cyclomatic complexity ${ccn} (threshold ${CCN_COMPLEX}; ${nloc} lines of code)`,
      tool_severity: ccn > CCN_VERY_COMPLEX ? "very-complex" : "complex",
      // Identity is the signature line, so the finding survives edits elsewhere in the file.
      snippet: input.snippet(file, start, start),
      raw_ref: `${input.rawRef}#L${i + 1}`,
      tags: [`ccn:${ccn}`],
    });
  });
  return { findings, metrics: { functions, complex_functions: complex, complex_functions_pct: pct(complex, functions) } };
}

// --- maint: jscpd -------------------------------------------------------------------------------

export interface JscpdMetrics {
  readonly [key: string]: unknown;
  readonly lines: number;
  readonly duplicated_lines: number;
  readonly clones: number;
  readonly duplication_pct: number;
}

/** jscpd `--reporters json` report: duplicates[] + statistics.total (integer fields only). */
/** jscpd names a code block inside Markdown "<file>.md:<format>"; the finding is the file. */
function jscpdPath(name: string): string {
  return name.replace(/(\.(?:md|mdx|markdown)):[A-Za-z0-9+#-]+$/, "$1");
}

export function jscpdAdapter(input: AdapterInput): { findings: FindingDraft[]; metrics: JscpdMetrics } {
  const root = obj(parseJson(input.raw, "jscpd"), "jscpd");
  const total = obj(obj(root["statistics"], "jscpd.statistics")["total"], "jscpd.statistics.total");
  const lines = int(total["lines"], "jscpd total.lines");
  const dupLines = int(total["duplicatedLines"], "jscpd total.duplicatedLines");
  const findings = arr(root["duplicates"], "jscpd.duplicates").map((entry, i) => {
    const d = obj(entry, `jscpd.duplicates[${i}]`);
    const a = obj(d["firstFile"], "jscpd firstFile");
    const b = obj(d["secondFile"], "jscpd secondFile");
    const fileA = repoPath(jscpdPath(str(a["name"], "jscpd firstFile.name")), input.repoRoot);
    const fileB = repoPath(jscpdPath(str(b["name"], "jscpd secondFile.name")), input.repoRoot);
    const [startA, endA] = [int(a["start"], "jscpd start"), int(a["end"], "jscpd end")];
    const [startB, endB] = [int(b["start"], "jscpd start"), int(b["end"], "jscpd end")];
    const n = int(d["lines"], "jscpd lines");
    return {
      ...base("maint", "jscpd", input.toolVersion),
      rule_id: "duplicate-block",
      category: "maintainability" as const,
      file: fileA, line: startA, end_line: endA,
      message: `${n} duplicated lines (also in ${fileB}:${startB}-${endB})`,
      tool_severity: "clone",
      snippet: excerpt(input.snippet, fileA, startA, endA),
      raw_ref: `${input.rawRef}#/duplicates/${i}`,
      tags: [`format:${str(d["format"], "jscpd format")}`, `clone-of:${fileB}`],
    };
  });
  return { findings, metrics: { lines, duplicated_lines: dupLines, clones: findings.length, duplication_pct: pct(dupLines, lines) } };
}

// --- iac: Checkov + hadolint --------------------------------------------------------------------

/**
 * Checkov `-o json --compact`: a summary object when nothing was scanned, one report object for
 * one framework, or a list of reports. Offline checks carry no severity (that needs the
 * platform API), so every failed check is tool_severity "failed" and the rubric decides.
 */
export function checkovAdapter(input: AdapterInput): FindingDraft[] {
  const parsed = parseJson(input.raw, "checkov");
  const reports = Array.isArray(parsed) ? parsed : [parsed];
  const out: FindingDraft[] = [];
  reports.forEach((entry, ri) => {
    const r = obj(entry, `checkov[${ri}]`);
    if (r["results"] === undefined) return; // summary only: no IaC found
    const checkType = str(r["check_type"], `checkov[${ri}].check_type`);
    arr(obj(r["results"], "checkov results")["failed_checks"], "checkov failed_checks").forEach((ce, ci) => {
      const c = obj(ce, `checkov failed_checks[${ci}]`);
      const file = repoPath(str(c["file_path"], "checkov file_path").replace(/^\//, ""), input.repoRoot);
      const range = arr(c["file_line_range"], "checkov file_line_range");
      const line = int(range[0], "checkov line", 0);
      const end = int(range[1], "checkov end line", line);
      const id = str(c["check_id"], "checkov check_id");
      const resource = typeof c["resource"] === "string" ? c["resource"] : "";
      out.push({
        ...base("iac", "checkov", input.toolVersion),
        rule_id: id,
        category: "iac",
        file, line, end_line: end,
        message: `${str(c["check_name"], "checkov check_name")}${resource !== "" ? ` (${resource})` : ""}`,
        tool_severity: "failed",
        snippet: null,
        engine_fingerprint: `${checkType}:${file}:${id}:${resource}`,
        raw_ref: `${input.rawRef}#/${Array.isArray(parsed) ? `${ri}/` : ""}results/failed_checks/${ci}`,
        tags: [`framework:${checkType}`],
      });
    });
  });
  return out;
}

/** hadolint `-f json`: [{code, column, file, level, line, message}]. */
export function hadolintAdapter(input: AdapterInput): FindingDraft[] {
  return arr(parseJson(input.raw, "hadolint"), "hadolint").map((entry, i) => {
    const h = obj(entry, `hadolint[${i}]`);
    const file = repoPath(str(h["file"], "hadolint file"), input.repoRoot);
    const line = int(h["line"], "hadolint line");
    const level = str(h["level"], "hadolint level");
    return {
      ...base("iac", "hadolint", input.toolVersion),
      rule_id: str(h["code"], "hadolint code"),
      category: "iac" as const,
      file, line, end_line: line,
      message: str(h["message"], "hadolint message"),
      tool_severity: level,
      snippet: excerpt(input.snippet, file, line, line),
      raw_ref: `${input.rawRef}#/${i}`,
      tags: ["dockerfile"],
    };
  });
}

// --- license: ScanCode + SBOM -------------------------------------------------------------------

export interface LicensePolicy {
  readonly classify: (expression: string) => LicenseClass;
  /** The client's own licenses (engagement.yml client_licenses): never flagged. */
  readonly clientLicenses: readonly string[];
}

export type LicenseCounts = Record<LicenseClass, number>;
const emptyCounts = (): LicenseCounts => ({ permissive: 0, "weak-copyleft": 0, unknown: 0, "strong-copyleft": 0, restricted: 0, "network-copyleft": 0 });

/** One license expression → its class, or null when it is never flagged (permissive / the client's own). */
function flagged(expr: string, policy: LicensePolicy): LicenseClass | null {
  if (policy.clientLicenses.includes(expr)) return null;
  const c = policy.classify(expr);
  return c === "permissive" ? null : c;
}

/** ScanCode `--license --json`, with --strip-root: files[] with detected_license_expression_spdx. */
export function scancodeAdapter(input: AdapterInput, policy: LicensePolicy): { findings: FindingDraft[]; metrics: { files: LicenseCounts } } {
  const root = obj(parseJson(input.raw, "scancode"), "scancode");
  const counts = emptyCounts();
  const findings: FindingDraft[] = [];
  arr(root["files"], "scancode.files").forEach((entry, i) => {
    const f = obj(entry, `scancode.files[${i}]`);
    if (f["type"] !== "file") return;
    const expr = f["detected_license_expression_spdx"];
    if (typeof expr !== "string" || expr === "") return;
    counts[policy.classify(expr)]++;
    const cls = flagged(expr, policy);
    if (cls === null) return;
    const file = repoPath(str(f["path"], "scancode path"), input.repoRoot);
    const matches = arr(f["license_detections"] ?? [], "scancode license_detections")
      .flatMap((d) => arr(obj(d, "scancode detection")["matches"] ?? [], "scancode matches").map((m) => obj(m, "scancode match")));
    const lines = matches.map((m) => [int(m["start_line"], "scancode start_line"), int(m["end_line"], "scancode end_line")] as const);
    const line = lines.length > 0 ? Math.min(...lines.map((x) => x[0])) : 0;
    const end = lines.length > 0 ? Math.max(...lines.map((x) => x[1])) : 0;
    findings.push({
      ...base("license", "scancode", input.toolVersion),
      rule_id: expr,
      category: "license",
      file, line, end_line: end,
      message: `Source file under ${expr} (${cls})`,
      tool_severity: cls,
      snippet: null,
      engine_fingerprint: `${file}:${expr}`,
      raw_ref: `${input.rawRef}#/files/${i}`,
      tags: [`license-class:${cls}`, "license-source:file"],
    });
  });
  return { findings, metrics: { files: counts } };
}

/** The manifest syft read a package from: "… manifest file: /package-lock.json" → "package-lock.json". */
function sbomSource(sourceInfo: unknown): string | null {
  if (typeof sourceInfo !== "string") return null;
  const m = /: (\/\S+)$/.exec(sourceInfo);
  return m?.[1] === undefined ? null : m[1].replace(/^\/+/, "");
}

/** syft SPDX JSON (the sca lane's SBOM): packages[] with a declared license. NOASSERTION is skipped, not guessed. */
export function sbomLicenseAdapter(input: AdapterInput, policy: LicensePolicy): { findings: FindingDraft[]; metrics: { packages: LicenseCounts } } {
  const root = obj(parseJson(input.raw, "sbom"), "sbom");
  const counts = emptyCounts();
  const findings: FindingDraft[] = [];
  const packages = root["packages"] === undefined ? [] : arr(root["packages"], "sbom.packages");
  packages.forEach((entry, i) => {
    const p = obj(entry, `sbom.packages[${i}]`);
    const expr = p["licenseDeclared"];
    if (typeof expr !== "string" || expr === "" || expr === "NOASSERTION" || expr === "NONE") return;
    counts[policy.classify(expr)]++;
    const cls = flagged(expr, policy);
    if (cls === null) return;
    const name = str(p["name"], "sbom package name");
    const version = typeof p["versionInfo"] === "string" ? p["versionInfo"] : "";
    const refs = Array.isArray(p["externalRefs"]) ? p["externalRefs"].map((r) => obj(r, "sbom externalRef")) : [];
    const purl = refs.find((r) => r["referenceType"] === "purl")?.["referenceLocator"];
    const id = typeof purl === "string" ? purl : `${name}@${version}`;
    const source = sbomSource(p["sourceInfo"]);
    findings.push({
      ...base("license", "syft", input.toolVersion),
      rule_id: expr,
      category: "license",
      file: source === null ? "." : repoPath(source, input.repoRoot),
      line: 0, end_line: 0,
      message: `Dependency ${name}@${version} is licensed ${expr} (${cls})`,
      tool_severity: cls,
      snippet: null,
      engine_fingerprint: `${id}:${expr}`,
      raw_ref: `${input.rawRef}#/packages/${i}`,
      tags: [`license-class:${cls}`, "license-source:dependency", `package:${name}@${version}`],
    });
  });
  return { findings, metrics: { packages: counts } };
}

// --- hygiene: Scorecard --local -----------------------------------------------------------------

/** Checks that work offline on a local checkout. Fuzzing, SAST, Vulnerabilities and the
 *  GitHub-API checks need the network or PR history; sca covers vulnerabilities. */
export const SCORECARD_CHECKS = [
  "Binary-Artifacts", "Dangerous-Workflow", "Dependency-Update-Tool", "License", "Packaging",
  "Pinned-Dependencies", "Security-Policy", "Token-Permissions",
] as const;

/** Scorecard `--format json`: checks[{name, score (-1..10), reason}]. The run date and the float aggregate are ignored. */
export function scorecardAdapter(input: AdapterInput): { findings: FindingDraft[]; metrics: { checks: Record<string, number> } } {
  const root = obj(parseJson(input.raw, "scorecard"), "scorecard");
  const scores: Record<string, number> = {};
  const findings: FindingDraft[] = [];
  arr(root["checks"], "scorecard.checks").forEach((entry, i) => {
    const c = obj(entry, `scorecard.checks[${i}]`);
    const name = str(c["name"], "scorecard check name");
    const score = int(c["score"], "scorecard score");
    if (score < -1 || score > 10) throw new ParseError(`scorecard ${name}: score ${score} out of range`);
    scores[name] = score;
    if (score < 0 || score > 4) return; // -1 = not applicable; 5+ = acceptable
    findings.push({
      ...base("hygiene", "scorecard", input.toolVersion),
      rule_id: name,
      category: "quality",
      file: ".", line: 0, end_line: 0,
      message: `Scorecard ${name}: ${String(score)}/10 (${str(c["reason"], "scorecard reason")})`,
      tool_severity: score <= 2 ? "failing" : "weak",
      snippet: null,
      engine_fingerprint: name,
      raw_ref: `${input.rawRef}#/checks/${i}`,
      tags: [`score:${String(score)}`],
    });
  });
  const sorted: Record<string, number> = {};
  for (const k of stableSort(Object.keys(scores), (x) => x)) sorted[k] = scores[k] ?? -1;
  return { findings, metrics: { checks: sorted } };
}

