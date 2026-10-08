// `radr address` (PRD §12, M2 AC10): report.md + remediation.md, both PURE functions of the
// latest run's state (findings, dispositions, metrics, locks, rubric). Same inputs → byte-
// identical files. Consultant prose lives in keep-blocks and survives regeneration.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson, hashBytes, stableSort } from "../core/determinism.js";
import type { Layout } from "../engagement/home.js";
import { debugStates, guardHolds } from "../debug/state.js";
import { groupByPackage, upgradeText, type PackageGroup } from "../findings/packages.js";
import { coverageGaps } from "../review/coverage.js";
import { findingsSetHash, readStore } from "../findings/store.js";
import type { Finding, Severity } from "../findings/types.js";
import { SEVERITIES } from "../findings/types.js";
import { sevRank } from "../rubric/rubric.js";
import { readSnapshotsLock } from "../toolchain/db.js";
import { readLock } from "../toolchain/doctor.js";
import { pyToolVersions } from "../toolchain/image.js";
import { ALL_PACKS, humanReviewTop25, ruleCoverage } from "../rules/pack.js";
import { dispositionsHash, type RunInputs } from "./inputs.js";
import { applyKeeps, code, esc, extractKeeps, keep, table } from "./markdown.js";
import { buildPlan, type PlanWave } from "./plan.js";
import { computeScorecard, type Scorecard } from "./scorecard.js";

export interface AddressPaths {
  readonly report: string;
  readonly remediation: string;
}

export function addressPaths(l: Layout): AddressPaths {
  return { report: path.join(l.dir, "report", "report.md"), remediation: path.join(l.dir, "plan", "remediation.md") };
}

const CATEGORY_TITLES: Readonly<Record<string, string>> = {
  secrets: "Secrets", dependency: "Vulnerable dependencies", security: "Security", quality: "Code quality",
  maintainability: "Build and maintainability", test: "Tests", coverage: "Coverage", iac: "Infrastructure as code", license: "Licenses",
};
const CATEGORY_ORDER = ["secrets", "dependency", "security", "maintainability", "test", "quality", "coverage", "iac", "license"];
const RATING_LABEL: Readonly<Record<string, string>> = { green: "Good", amber: "Watch", red: "At risk", grey: "Not measured" };
const VERDICT_LABEL: Readonly<Record<string, string>> = { healthy: "Healthy", "needs-attention": "Needs attention", "at-risk": "At risk" };
const TOP_RISKS = 10;

/** Keep-block defaults. `radr address --draft` fills only blocks whose body is still this text. */
export const KEEP_DEFAULTS = {
  "executive-summary": "_Write the executive summary here. radr preserves this block when the report is regenerated._",
  recommendations: "_Consultant recommendations. Preserved across regeneration._",
  "plan-notes": "_Sequencing notes, owners, and constraints. Preserved across regeneration._",
} as const;

const loc = (f: Finding): string => (f.line > 0 ? `${f.file}:${String(f.line)}` : f.file);
const state = (inp: RunInputs, f: Finding): string => inp.states.get(f.id) ?? "pending";
const live = (inp: RunInputs): Finding[] => inp.findings.filter((f) => state(inp, f) !== "dismissed");
const bySeverity = (fs: readonly Finding[]): Finding[] => stableSort(fs, (f) => [-sevRank(f.severity), f.id]);

function frontMatter(inp: RunInputs, l: Layout, card: Scorecard | undefined, runDate: string): string {
  const s = (v: string) => canonicalJson(v); // JSON strings are valid YAML scalars, safely quoted
  return [
    "---",
    `title: ${s(`Code review: ${inp.doc.client} / ${inp.doc.slug}`)}`,
    `client: ${s(inp.doc.client)}`,
    `engagement: ${s(l.id)}`,
    `engagement_type: ${s(inp.doc.engagement_type)}`,
    `date: ${s(runDate)}`,
    `run: ${s(inp.runId)}`,
    `commit: ${s(inp.doc.source.sha)}`,
    `verdict: ${s(card === undefined ? "n/a" : (VERDICT_LABEL[card.verdict] ?? card.verdict))}`,
    `findings_set: ${s(findingsSetHash(inp.findings))}`,
    `dispositions: ${s(dispositionsHash(inp))}`,
    "---",
  ].join("\n");
}

function scorecardSection(card: Scorecard): string {
  return [
    `**Overall: ${VERDICT_LABEL[card.verdict] ?? card.verdict}**`,
    "",
    table(["Area", "Result", "Value"], card.rows.map((r) => [esc(r.label), RATING_LABEL[r.rating] ?? r.rating, r.value === null ? "—" : esc(String(r.value))]), [50, 14, 36]),
  ].join("\n");
}

/** Finding ids for a table cell: all of them when few, else the first few and a count. */
const idList = (fs: readonly Finding[]): string => (fs.length <= 3 ? fs.map((f) => f.id).join(", ") : `${fs.slice(0, 2).map((f) => f.id).join(", ")} and ${String(fs.length - 2)} more`);

/** One package's advisories as a sentence: "npm hono@4.11.7: 34 advisories; upgrade to ≥ 4.12.4". */
const packageLine = (g: PackageGroup): string => {
  const one = g.findings.length === 1 ? g.findings[0] : undefined;
  const what = one === undefined ? `${g.ecosystem} ${g.pkg}: ${String(g.findings.length)} advisories` : one.message;
  return g.upgradeTo === null ? `${what}; no fixed version known` : `${what}; upgrade to ${upgradeText(g)}`;
};

function topRisks(inp: RunInputs): string {
  // Dependency advisories collapse to one bullet per package (user decision 2026-10-08).
  // Group all of a package's advisories (so the upgrade target matches the findings table), then
  // keep the packages, and the other findings, at high or above.
  const high = (s: Severity) => sevRank(s) >= sevRank("high");
  const all = groupByPackage(live(inp));
  const groups = all.groups.filter((g) => high(g.severity));
  const rest = all.rest.filter((f) => high(f.severity));
  const items = stableSort([
    ...groups.map((g) => ({ sev: g.severity, key: g.findings[0]?.id ?? "", text: `${esc(packageLine(g))} (${code(g.files.join(", "))}, ${idList(g.findings)})` })),
    ...rest.map((f) => ({ sev: f.severity, key: f.id, text: `${esc(f.message)} (${code(loc(f))}, ${f.id})` })),
  ], (x) => [-sevRank(x.sev), x.key]).slice(0, TOP_RISKS);
  if (items.length === 0) return "No critical or high-severity findings.";
  return items.map((x) => `- **${x.sev.toUpperCase()}** · ${x.text}`).join("\n");
}

function findingsByCategory(inp: RunInputs, order: readonly string[] = CATEGORY_ORDER): string {
  const fs = live(inp);
  const cats = stableSort([...new Set(fs.map((f) => f.category))], (c) => [order.indexOf(c) === -1 ? 99 : order.indexOf(c), c]);
  if (cats.length === 0) return "No open findings.";
  return cats.map((c) => {
    if (c === "dependency") return [`### ${CATEGORY_TITLES[c] ?? c}`, "", dependencyTable(fs.filter((f) => f.category === c))].join("\n");
    const rows = bySeverity(fs.filter((f) => f.category === c)).map((f) => [f.id, f.severity, esc(state(inp, f)), code(`${f.tool}/${f.rule_id}`), code(loc(f)), esc(f.message)]);
    return [`### ${CATEGORY_TITLES[c] ?? esc(c)}`, "", table(["ID", "Severity", "State", "Rule", "Location", "Finding"], rows, [8, 9, 10, 22, 19, 32])].join("\n");
  }).join("\n\n");
}

function coverageSection(inp: RunInputs): string | null {
  const stacks = (inp.metrics["coverage"] as { stacks?: Record<string, { status: string; line_pct: number | null; branch_pct: number | null }> } | undefined)?.stacks;
  if (stacks === undefined || Object.keys(stacks).length === 0) return null;
  const pctText = (v: number | null) => (v === null ? "—" : `${String(v)}%`);
  const t = table(["Stack", "Result", "Line coverage", "Branch coverage"],
    stableSort(Object.entries(stacks), ([k]) => k).map(([k, m]) => [esc(k), esc(m.status), pctText(m.line_pct), pctText(m.branch_pct)]));
  const notes = [
    ...(Object.hasOwn(stacks, "go") ? ["Go reports statement coverage (shown in the line column)."] : []),
    ...(["rust", "java-kotlin", "php", "ruby", "csharp"].some((k) => Object.hasOwn(stacks, k)) ? ["For Rust, JVM, PHP, Ruby and .NET, radr runs the test suite (twice, for stability) but does not measure coverage."] : []),
  ];
  return notes.length === 0 ? t : `${t}\n\n${notes.join(" ")}`;
}

const PACK_LABEL: Readonly<Record<string, string>> = {
  authored: "radr authored", pack: "vendored permissive (GitLab sast-rules MIT/Apache-2.0, elttam)", lgpl: "LGPL-3.0 sub-pack (GitLab sast-rules)",
};

/** SAST rule packs and the per-stack support bar (PRD §14.2) for the stacks this review covered. */
function sastSupport(inp: RunInputs): string[] {
  if (!inp.lanes.has("sast")) return [];
  const packs = inp.doc.rule_packs ?? ALL_PACKS;
  const cov = ruleCoverage(packs).filter((c) => (inp.doc.stacks as readonly string[]).includes(c.stack));
  const rows = cov.map((c) => [esc(c.stack), c.supported ? "supported" : "partial", `${String(c.covered.length)}/${String(c.covered.length + c.missing.length)}`,
    String(c.rules), c.missing.length === 0 ? "—" : esc(c.missing.map((m) => `CWE-${String(m)}`).join(", "))]);
  const out = ["", "**Static analysis (SAST) coverage**", "",
    `Rule packs: ${esc(packs.map((p) => PACK_LABEL[p] ?? p).join("; "))}. Every rule passes its own positive and negative test fixtures. A stack is *supported* when each of its top-10 weakness targets has at least one rule; *partial* stacks list the gaps.`];
  if (rows.length > 0) out.push("", table(["Stack", "Support", "Targets", "Rules", "Gaps"], rows));
  const human = humanReviewTop25();
  if (human.length > 0) {
    out.push("", `Not detectable by automated tools, and outside this review unless listed in the findings: ${esc(human.map((h) => `${h.name} (CWE-${String(h.cwe)})`).join("; "))}.`);
  }
  return out;
}

function methodology(inp: RunInputs, l: Layout): string {
  const lock = readLock(l.toolchainLock);
  const snaps = readSnapshotsLock(l.snapshotsLock);
  const toolVersions: Record<string, string> = Object.fromEntries(Object.entries(lock.tools).map(([k, v]) => [k, v.version]));
  if (lock.mode === "container") Object.assign(toolVersions, pyToolVersions()); // the image's Python tools
  const tools = stableSort(Object.entries(toolVersions), ([k]) => k).map(([k, v]) => `${k} ${v}`);
  const laneRows = stableSort([...inp.lanes], ([k]) => k).map(([lane, outcome]) => [esc(lane), esc(outcome)]);
  const dismissed = inp.findings.filter((f) => state(inp, f) === "dismissed").length;
  const waived = inp.findings.filter((f) => state(inp, f) === "waived").length;
  const defs = inp.rubric.definitions;
  const llmCalls = inp.events.filter((e) => e.type === "llm-call");
  const aiUsed = inp.doc.llm_policy !== "off" || llmCalls.length > 0;
  const provenance = acceptedJudgments(inp).length === 0
    ? "Every finding traces to a specific tool's output (rule id and location). No finding was created or rated by an AI model."
    : "Every tool finding traces to a specific tool's output (rule id and location). Judgment findings (J-…) were proposed with AI assistance and confirmed by the consultant; no severity was set by an AI model.";
  const lines = [
    `This review analyzed commit ${code(inp.doc.source.sha)} with a pinned, checksum-verified toolchain. ${provenance}`,
    "",
    table(["Item", "Value"], [
      ["Engagement type / tier", esc(`${inp.doc.engagement_type} / ${inp.doc.tier}`)],
      ["Run", esc(`${inp.runId} (${inp.runStatus})`)],
      ["Tools", esc(tools.join(", "))],
      ["Toolchain", lock.mode === "container" && lock.image !== undefined && lock.image !== null ? esc(`container image ${lock.image.id.slice(0, 19)} (network denied)`) : "host (pinned binaries)"],
      ["Sandbox", lock.sandbox === undefined || lock.sandbox === null ? "none" : esc(`${lock.sandbox.runtime} (pinned images)`)],
      ["Vulnerability data", esc([snaps.osv === null ? "OSV: none" : `OSV ${snaps.osv.id}`, snaps.epss ? `EPSS ${snaps.epss.published}` : "EPSS: none", snaps.kev ? `KEV ${snaps.kev.published}` : "KEV: none"].join("; "))],
      ["Severity rubric", esc(inp.rubric.version)],
      ["AI (LLM) policy", esc(inp.doc.llm_policy)],
      ...(aiUsed ? [["AI (LLM) agent calls", esc(aiCallSummary(llmCalls))]] : []),
      ["Network", esc(`${inp.doc.network.mode} (${inp.doc.network.enforcement})`)],
      ["Dismissed / waived findings", `${String(dismissed)} / ${String(waived)}`],
    ]),
    "",
    "**Lanes**",
    "",
    table(["Lane", "Outcome"], laneRows),
    ...sastSupport(inp),
  ];
  // Coverage gaps have their own section near the top; the rest of the run's notes stay here.
  const other = inp.notes.filter((n) => !n.startsWith("not assessed: "));
  if (other.length > 0) lines.push("", "**Gaps**", "", ...other.map((n) => `- ${esc(n)}`));
  if (defs !== undefined) {
    lines.push("", "**Severity definitions**", "", table(["Severity", "Meaning"], [...SEVERITIES].reverse().map((s: Severity) => [s, esc(defs[s])]), [14, 86]));
  }
  return lines.join("\n");
}

/** "N calls (agent <argv hash prefix>)": every prompt and response is kept in the engagement's llm/. */
function aiCallSummary(calls: readonly { readonly data: Readonly<Record<string, unknown>> }[]): string {
  if (calls.length === 0) return "none";
  const agents = stableSort([...new Set(calls.map((c) => String(c.data["argv_hash"]).slice(7, 19)))], (x) => x);
  return `${String(calls.length)} (agent ${agents.join(", ")}); every prompt and response is retained`;
}

type ClassCounts = Readonly<Record<string, number>>;
const LICENSE_ORDER = ["network-copyleft", "restricted", "strong-copyleft", "unknown", "weak-copyleft", "permissive"] as const;

/** License inventory (license lane metrics): counts by §4b class, source files and dependencies. */
function licenseSection(inp: RunInputs): string | null {
  const m = inp.metrics["license"] as { files?: ClassCounts; packages?: ClassCounts } | undefined;
  if (m === undefined || (m.files === undefined && m.packages === undefined)) return null;
  const n = (c: ClassCounts | undefined, k: string): string => (c === undefined ? "—" : String(c[k] ?? 0));
  return [
    "Licenses detected in source files (ScanCode) and declared by dependencies (lockfile metadata), by class. Permissive licenses and the client's own licenses produce no findings.",
    "",
    table(["Class", "Source files", "Dependencies"], LICENSE_ORDER.map((k) => [esc(k), n(m.files, k), n(m.packages, k)])),
    ...(m.packages === undefined ? ["", "Dependency licenses were not assessed (no SBOM from the dependency lane in this run)."] : []),
  ].join("\n");
}

/** OpenSSF Scorecard (offline subset) scores, if the optional hygiene lane ran. */
function hygieneSection(inp: RunInputs): string | null {
  const checks = (inp.metrics["hygiene"] as { checks?: Readonly<Record<string, number>> } | undefined)?.checks;
  if (checks === undefined || Object.keys(checks).length === 0) return null;
  const rows = stableSort(Object.entries(checks), ([k]) => k).map(([k, v]) => [esc(k), v < 0 ? "not applicable" : `${String(v)}/10`]);
  return `OpenSSF Scorecard, offline checks only (checks that need the network or pull-request history are not run).\n\n${table(["Check", "Score"], rows)}`;
}

/** Judgments a person accepted (confirmed or waived; M4). Proposed/pending ones block Gate 2. */
const acceptedJudgments = (inp: RunInputs): Finding[] => bySeverity(inp.judgments.filter((j) => ["confirmed", "waived"].includes(state(inp, j))));

function judgmentSection(inp: RunInputs): string | null {
  const js = acceptedJudgments(inp);
  if (js.length === 0) return null;
  const rows = js.map((j) => [j.id, j.severity, esc(state(inp, j)), esc(j.category), code(loc(j)), esc(j.message)]);
  return [
    "These findings come from consultant review assisted by an AI model, not from a tool. Each was proposed with a file and line reference, checked against the reviewed commit, and confirmed by the consultant. Their severity comes from the rubric (or a recorded consultant decision), never from the model. They are not part of the remediation plan's re-runnable checks.",
    "",
    table(["ID", "Severity", "State", "Category", "Location", "Finding"], rows, [8, 9, 10, 14, 19, 40]),
  ].join("\n");
}

function appendix(inp: RunInputs): string {
  const rows = [...bySeverity(inp.findings), ...acceptedJudgments(inp)].map((f) => [f.id, f.severity, esc(state(inp, f)), code(f.class === "judgment" ? "judgment (AI-assisted)" : `${f.tool}/${f.rule_id}`), code(loc(f))]);
  return rows.length === 0 ? "No findings." : table(["ID", "Severity", "State", "Rule", "Location"], rows, [10, 12, 12, 34, 32]);
}

function planSummary(waves: readonly PlanWave[]): string {
  const rows = waves.map((w) => [String(w.wave), esc(w.label), String(w.items.length), String(w.items.reduce((n, i) => n + i.findings.length, 0))]);
  return `${table(["Wave", "Focus", "Work items", "Findings"], rows)}\n\nThe full plan, with effort and acceptance criteria, is in the remediation plan.`;
}

// --- Report templates per engagement type (PRD §5, §12) ----------------------------------------
// A template is an ordered list of sections plus the order of finding categories. Sections with
// nothing to show are left out. health-audit is the balanced default; triage is the one-page
// verdict; the others put their emphasis first.

type SectionId =
  | "executive-summary" | "at-a-glance" | "top-risks" | "key-risks" | "findings" | "judgments" | "coverage" | "licenses"
  | "hygiene" | "remediation" | "recommendations" | "verification" | "methodology" | "appendix"
  | "security-posture" | "vulnerabilities" | "secrets" | "maintainability" | "hotspots" | "license-risk" | "coverage-gaps";

interface Template {
  readonly sections: readonly SectionId[];
  readonly categoryOrder: readonly string[];
}

const BALANCED: Template = {
  sections: ["executive-summary", "at-a-glance", "coverage-gaps", "top-risks", "findings", "judgments", "coverage", "licenses", "hygiene", "remediation", "recommendations", "verification", "methodology", "appendix"],
  categoryOrder: CATEGORY_ORDER,
};

export const TEMPLATES: Readonly<Record<string, Template>> = {
  "health-audit": BALANCED,
  "pr-review": BALANCED,
  debug: BALANCED,
  triage: { sections: ["executive-summary", "at-a-glance", "coverage-gaps", "top-risks", "judgments", "verification", "methodology"], categoryOrder: CATEGORY_ORDER },
  // Code quality: lint, types, complexity, duplication, tests first; security still reported.
  quality: {
    sections: ["executive-summary", "at-a-glance", "coverage-gaps", "top-risks", "maintainability", "findings", "judgments", "coverage", "remediation", "recommendations", "licenses", "hygiene", "verification", "methodology", "appendix"],
    categoryOrder: ["quality", "maintainability", "test", "coverage", "security", "secrets", "dependency", "iac", "license"],
  },
  // Security: posture, secrets, and vulnerabilities with CVSS/EPSS/KEV first.
  security: {
    sections: ["executive-summary", "security-posture", "coverage-gaps", "top-risks", "secrets", "vulnerabilities", "findings", "judgments", "licenses", "remediation", "recommendations", "at-a-glance", "coverage", "hygiene", "verification", "methodology", "appendix"],
    categoryOrder: ["secrets", "security", "dependency", "iac", "license", "maintainability", "test", "quality", "coverage"],
  },
  // Due diligence: exec-first; risks a buyer weighs (hotspots, bus factor, licenses, CVEs).
  "due-diligence": {
    sections: ["executive-summary", "key-risks", "at-a-glance", "coverage-gaps", "hotspots", "license-risk", "vulnerabilities", "maintainability", "findings", "judgments", "coverage", "hygiene", "remediation", "recommendations", "verification", "methodology", "appendix"],
    categoryOrder: ["license", "secrets", "dependency", "security", "maintainability", "test", "coverage", "iac", "quality"],
  },
};

export function templateFor(engagementType: string): Template {
  return TEMPLATES[engagementType] ?? BALANCED;
}

const SECURITY_CATEGORIES = ["secrets", "security", "dependency", "iac", "license"] as const;

function securityPosture(inp: RunInputs): string {
  const fs = live(inp);
  const rows = SECURITY_CATEGORIES.map((c) => [CATEGORY_TITLES[c] ?? c, ...[...SEVERITIES].reverse().map((s) => String(fs.filter((f) => f.category === c && f.severity === s).length))]);
  const kev = fs.filter((f) => f.kev === true).length;
  const epss = fs.filter((f) => f.epss_bp !== null && f.epss_bp >= 1000).length;
  return [
    table(["Area", "Critical", "High", "Medium", "Low", "Info"], rows),
    "",
    `Known-exploited (CISA KEV): ${String(kev)}. Likely to be exploited (EPSS 10% or more): ${String(epss)}. Dismissed findings are not counted.`,
  ].join("\n");
}

/** Coverage gaps (src/review/coverage.ts), recomputed from the run's metrics. */
function coverageSectionGaps(inp: RunInputs): string | null {
  const gaps = coverageGaps(inp.doc, inp.metrics);
  if (gaps.length === 0) return null;
  return [
    "A check that finds nothing only means something if it looked. These parts of the codebase were not assessed, so the absence of findings there says nothing about them:",
    "",
    ...gaps.map((g) => `- ${esc(g)}`),
  ].join("\n");
}

/** EPSS in basis points as a percentage with two decimals, without floats. */
const epssPct = (bp: number | null): string => (bp === null ? "—" : `${String(Math.floor(bp / 100))}.${String(bp % 100).padStart(2, "0")}%`);

/** Vulnerable dependencies, one row per package (every advisory stays in the appendix). */
function dependencyTable(fs: readonly Finding[]): string {
  const { groups, rest } = groupByPackage(fs);
  const rows = groups.map((g) => [esc(`${g.ecosystem} ${g.pkg}`), g.severity, String(g.findings.length), esc(upgradeText(g)), code(g.files.join(", ")), idList(g.findings)]);
  const parts = [
    `${String(fs.length)} advisories in ${String(groups.length)} package(s). Upgrading each package to the version shown resolves every advisory against it that has a fix.`,
    "",
    table(["Package", "Severity", "Advisories", "Upgrade to", "Location", "Findings"], rows, [24, 9, 10, 20, 17, 20]),
  ];
  if (rest.length > 0) parts.push("", table(["ID", "Severity", "Rule", "Location", "Finding"], bySeverity(rest).map((f) => [f.id, f.severity, code(`${f.tool}/${f.rule_id}`), code(loc(f)), esc(f.message)])));
  return parts.join("\n");
}

function vulnerabilities(inp: RunInputs): string {
  const fs = live(inp).filter((f) => f.cve !== null || f.aliases.some((a) => a.startsWith("CVE-")));
  if (fs.length === 0) return "No findings with a known CVE.";
  // One row per package; findings with a CVE but no package (rare) keep their own row.
  const { groups, rest } = groupByPackage(fs);
  const rows = [
    ...groups.map((g) => [esc(`${g.ecosystem} ${g.pkg}`), g.severity, String(g.cves.length), g.maxCvss ?? "—", epssPct(g.maxEpssBp), g.findings.some((f) => f.kev !== null) ? (g.kev ? "yes" : "no") : "—", esc(upgradeText(g))]),
    ...bySeverity(rest).map((f) => [code(loc(f)), f.severity, "1", f.cvss ?? "—", epssPct(f.epss_bp), f.kev === null ? "—" : f.kev ? "yes" : "no", f.id]),
  ];
  return table(["Package", "Severity", "CVEs", "Max CVSS", "Max EPSS", "KEV", "Upgrade to"], rows);
}

function secretsSection(inp: RunInputs): string {
  const fs = bySeverity(live(inp).filter((f) => f.category === "secrets"));
  if (fs.length === 0) return inp.lanesRun.has("secrets") ? "No secrets found." : "The secrets lane did not run.";
  return [
    "Every credential found must be rotated, including those that exist only in the history: anyone with a clone of the repository has them.",
    "",
    table(["ID", "Severity", "Rule", "Location", "Where"], fs.map((f) => [f.id, f.severity, code(`${f.tool}/${f.rule_id}`), code(loc(f)), f.tags.includes("history-only") ? "history only" : "at the reviewed commit"])),
  ].join("\n");
}

function maintainability(inp: RunInputs): string | null {
  const m = inp.metrics["maint"];
  if (m === undefined) return null;
  const n = (k: string): string => (typeof m[k] === "number" ? String(m[k]) : "—");
  const complex = live(inp).filter((f) => f.tool === "lizard").length;
  return [
    table(["Measure", "Value"], [
      ["Functions analyzed", n("functions")], ["Complex functions", n("complex_functions")], ["Complex functions (%)", n("complex_functions_pct")],
      ["Duplicated lines (%)", n("duplication_pct")], ["Duplicated blocks", n("clones")],
    ]),
    "",
    `${String(complex)} function(s) are complex enough to be findings (cyclomatic complexity over 15). Duplication is a metric, not a finding per block.`,
  ].join("\n");
}

function hotspots(inp: RunInputs): string | null {
  const h = inp.metrics["history"];
  if (h === undefined) return null;
  const n = (k: string): string => (typeof h[k] === "number" ? String(h[k]) : "—");
  const window = h["window"] as { commits?: number } | undefined;
  const spots = (Array.isArray(h["hotspots"]) ? h["hotspots"] : []) as { file: string; churn: number; complexity: number }[];
  return [
    table(["Measure", "Value"], [
      ["Authors", n("authors")], ["Bus factor (fewest authors covering half the commits)", n("bus_factor")],
      ["Commits in the window", window?.commits === undefined ? "—" : String(window.commits)], ["Churn in the most complex files (%)", n("churn_hotspot_pct")],
    ]),
    ...(spots.length === 0 ? [] : ["", "**Hotspots** (frequently changed and complex: where defects and cost concentrate)", "",
      table(["File", "Churn (lines)", "Complexity"], spots.slice(0, TOP_RISKS).map((x) => [code(x.file), String(x.churn), String(x.complexity)]))]),
  ].join("\n");
}

export function renderReport(inp: RunInputs, l: Layout, card: Scorecard | undefined, waves: readonly PlanWave[], runDate: string): string {
  const t = templateFor(inp.doc.engagement_type);
  const render: Record<SectionId, () => [string, string | null]> = {
    "executive-summary": () => ["Executive summary", keep("executive-summary", KEEP_DEFAULTS["executive-summary"])],
    "at-a-glance": () => ["At a glance", card === undefined ? null : scorecardSection(card)],
    "top-risks": () => ["Top risks", topRisks(inp)],
    "key-risks": () => ["Key risks", topRisks(inp)],
    findings: () => ["Findings", findingsByCategory(inp, t.categoryOrder)],
    judgments: () => ["Judgment findings", judgmentSection(inp)],
    coverage: () => ["Test coverage", coverageSection(inp)],
    licenses: () => ["Licenses", licenseSection(inp)],
    hygiene: () => ["Repository hygiene", hygieneSection(inp)],
    remediation: () => ["Remediation overview", planSummary(waves)],
    recommendations: () => ["Recommendations", keep("recommendations", KEEP_DEFAULTS.recommendations)],
    verification: () => ["Verification", verificationSection(inp, l)],
    methodology: () => ["Methodology", methodology(inp, l)],
    appendix: () => ["Appendix: all findings", appendix(inp)],
    "security-posture": () => ["Security posture", securityPosture(inp)],
    vulnerabilities: () => ["Known vulnerabilities", vulnerabilities(inp)],
    secrets: () => ["Secrets", secretsSection(inp)],
    maintainability: () => ["Maintainability", maintainability(inp)],
    hotspots: () => ["Hotspots and ownership", hotspots(inp)],
    // Due diligence: license risk is a deal term, so its absence is stated, never silent.
    "coverage-gaps": () => ["What this review could not assess", coverageSectionGaps(inp)],
    "license-risk": () => ["License risk", licenseSection(inp) ?? "License compliance was not assessed in this run: the license lane runs only in container mode (`network: { mode: offline, enforcement: container }`). Treat license risk as unknown."],
  };
  const parts = [frontMatter(inp, l, card, runDate)];
  for (const id of t.sections) {
    const [heading, body] = render[id]();
    if (body !== null) parts.push("", `# ${heading}`, "", body);
  }
  return `${parts.join("\n")}\n`;
}

export function renderRemediation(inp: RunInputs, l: Layout, waves: readonly PlanWave[], sizes: Readonly<Record<string, string>>, runDate: string): string {
  const s = (v: string) => canonicalJson(v);
  const parts = [
    "---",
    `title: ${s(`Remediation plan: ${inp.doc.client} / ${inp.doc.slug}`)}`,
    `engagement: ${s(l.id)}`,
    `date: ${s(runDate)}`,
    `run: ${s(inp.runId)}`,
    "---",
    "",
    "# Remediation plan",
    "",
    `Effort sizes: ${stableSort(Object.entries(sizes), ([k]) => k).map(([k, v]) => `**${k}** ${esc(v)}`).join(" · ")}.`,
    "",
    keep("plan-notes", KEEP_DEFAULTS["plan-notes"]),
  ];
  const v = verifyEvent(inp);
  if (v !== undefined) {
    const moved = inp.events.filter((e) => e.type === "finding-disposition" && e.actor === `verify@${inp.runId}`).map((e) => String(e.data["to"]));
    parts.splice(parts.indexOf("# Remediation plan") + 2, 0, `Verified against ${v.against} at ${code(v.commit.slice(0, 12))}: ${String(moved.filter((x) => x === "verified").length)} verified, ${String(moved.filter((x) => x === "regressed").length)} regressed. This plan lists only what is still open.`, "");
  }
  for (const w of waves) {
    parts.push("", `## Wave ${String(w.wave)}: ${esc(w.label)}`, "");
    if (w.items.length === 0) {
      parts.push("Nothing in this wave.");
      continue;
    }
    w.items.forEach((it, i) => {
      parts.push(`### ${String(w.wave)}.${String(i + 1)} ${esc(it.title)}`, "",
        table(["Severity", "Effort", "Findings"], [[it.severity, it.effort, it.findings.join(", ")]]), "",
        `**Done when:** ${esc(it.acceptance)}.`, ...(i < w.items.length - 1 ? [""] : []));
    });
  }
  const fixes = debugFixes(inp);
  if (fixes !== null) parts.push("", "## Debug fixes", "", fixes);
  return `${parts.join("\n").replace(/\n+$/, "")}\n`;
}

/** The verify pass that produced this run (M6), if any. */
function verifyEvent(inp: RunInputs): { against: string; commit: string; stillPresent: number } | undefined {
  const e = inp.events.findLast((x) => x.type === "verify-completed" && x.data["run_id"] === inp.runId);
  return e === undefined ? undefined : { against: String(e.data["against"]), commit: String(e.data["commit"]), stillPresent: Number(e.data["still_present"]) };
}

function verificationSection(inp: RunInputs, l: Layout): string | null {
  const v = verifyEvent(inp);
  if (v === undefined) return null;
  const actor = `verify@${inp.runId}`;
  const moved = new Map<string, string>();
  for (const e of inp.events) if (e.type === "finding-disposition" && e.actor === actor) moved.set(String(e.data["finding_id"]), String(e.data["to"]));
  const all = new Map(readStore(l.findings).findings.map((f) => [f.id, f]));
  const rows = stableSort([...moved], ([id]) => id).map(([id, to]) => {
    const f = all.get(id);
    return [id, f?.severity ?? "", to, f === undefined ? "" : code(`${f.tool}/${f.rule_id}`), f === undefined ? "" : code(loc(f))];
  });
  const count = (s: string) => [...moved.values()].filter((x) => x === s).length;
  return [
    `This run re-checked the findings of ${v.against} at commit ${code(v.commit)}. A finding is **fixed** when it is absent, **verified** when it is absent and its lane ran clean, and **regressed** when a fixed finding came back.`,
    "",
    table(["Result", "Findings"], [["verified", String(count("verified"))], ["fixed (not verified)", String(count("fixed"))], ["regressed", String(count("regressed"))], ["still present", String(v.stillPresent)]]),
    ...(rows.length === 0 ? [] : ["", table(["ID", "Severity", "Now", "Rule", "Location"], rows)]),
  ].join("\n");
}

/** Root-caused debugs concluded with --to-plan (M5): re-runnable via their regression guard. */
function debugFixes(inp: RunInputs): string | null {
  const ds = [...debugStates(inp.events).values()].filter((d) => d.conclusion?.outcome === "root-caused" && d.conclusion.toPlan);
  if (ds.length === 0) return null;
  return ds.map((d) => [
    `### ${d.id} ${esc(d.conclusion?.summary ?? "")}`, "",
    table(["Introduced by", "Regression guard"], [[d.conclusion?.introducingCommit === undefined ? "unknown" : code(d.conclusion.introducingCommit.slice(0, 12)), guardHolds(d) ? "holds" : "not yet recorded"]]), "",
    `**Done when:** the regression guard (${code(`debug/${d.id}/guard/guard.sh`)} with ${code("test.patch")}) passes at the fixed commit (\`radr debug guard ${d.id} --fix-commit <sha>\`).`,
  ].join("\n")).join("\n\n");
}

export interface AddressResult {
  readonly paths: AddressPaths;
  readonly reportHash: string;
  readonly remediationHash: string;
  readonly setHash: string;
  readonly items: number;
}

function writeWithKeeps(file: string, generated: string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  const body = existsSync(file) ? applyKeeps(generated, extractKeeps(readFileSync(file, "utf8"))) : generated;
  writeFileSync(file, body);
  return hashBytes(body);
}

export function writeAddress(inp: RunInputs, l: Layout): AddressResult {
  const completed = inp.events.findLast((e) => e.type === "run-completed" && e.data["run_id"] === inp.runId);
  const runDate = (completed?.at ?? "").slice(0, 10);
  const card = inp.rubric.scorecard === undefined ? undefined : computeScorecard(inp.rubric.scorecard, inp);
  const waves = buildPlan(inp.findings, inp.states, inp.rubric.effort?.by_kind ?? {});
  const paths = addressPaths(l);
  const reportHash = writeWithKeeps(paths.report, renderReport(inp, l, card, waves, runDate));
  const remediationHash = writeWithKeeps(paths.remediation, renderRemediation(inp, l, waves, inp.rubric.effort?.sizes ?? {}, runDate));
  return { paths, reportHash, remediationHash, setHash: findingsSetHash(inp.findings), items: waves.reduce((n, w) => n + w.items.length, 0) };
}
