// Finding shapes (PRD §8). Adapters emit FindingDrafts; the store adds fingerprint, ID, and
// rubric severity. Nothing here is set by an LLM.

export type Category = "security" | "quality" | "maintainability" | "dependency" | "license" | "iac" | "secrets" | "test" | "coverage";
export type Severity = "info" | "low" | "medium" | "high" | "critical";
export const SEVERITIES: readonly Severity[] = ["info", "low", "medium", "high", "critical"];

export interface FindingDraft {
  readonly lane: string;
  readonly tool: string;
  readonly tool_version: string;
  readonly rule_id: string;
  readonly category: Category;
  /** Repo-relative POSIX path. */
  readonly file: string;
  readonly line: number;
  readonly end_line: number;
  readonly message: string;
  /** The tool's own severity label, verbatim (input to the rubric). */
  readonly tool_severity: string;
  /** Code excerpt, kept separable so it can be redacted (PRD §9, §20 #6). Never contains secrets. */
  readonly snippet: string | null;
  /** Stable identity supplied by the engine, if any (gitleaks Fingerprint, OSV package+advisory). */
  readonly engine_fingerprint: string | null;
  readonly cve: string | null;
  /** Advisory aliases (CVE/GHSA/PYSEC), sorted. */
  readonly aliases: readonly string[];
  /** CVSS base score as a decimal STRING ("7.2"), never a float (PRD §15). */
  readonly cvss: string | null;
  /** Pointer into raw/ (path + locator) proving this finding came from tool output. */
  readonly raw_ref: string;
  /** Lint mode etc.; small, canonical-JSON-safe extras. */
  readonly tags: readonly string[];
}

export interface Finding extends FindingDraft {
  readonly type: "finding";
  readonly id: string;
  readonly fingerprint: string;
  readonly class: "tool" | "judgment";
  readonly severity: Severity;
  readonly rubric_version: string;
  readonly snippet_hash: string | null;
}
