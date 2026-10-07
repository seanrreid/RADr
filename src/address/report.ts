// `radr address` (PRD §12, M2 AC10): report.md + remediation.md, both PURE functions of the
// latest run's state (findings, dispositions, metrics, locks, rubric). Same inputs → byte-
// identical files. Consultant prose lives in keep-blocks and survives regeneration.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson, hashBytes, stableSort } from "../core/determinism.js";
import type { Layout } from "../engagement/home.js";
import { findingsSetHash } from "../findings/store.js";
import type { Finding, Severity } from "../findings/types.js";
import { SEVERITIES } from "../findings/types.js";
import { sevRank } from "../rubric/rubric.js";
import { readSnapshotsLock } from "../toolchain/db.js";
import { readLock } from "../toolchain/doctor.js";
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

function topRisks(inp: RunInputs): string {
  const risky = bySeverity(live(inp).filter((f) => sevRank(f.severity) >= sevRank("high"))).slice(0, TOP_RISKS);
  if (risky.length === 0) return "No critical or high-severity findings.";
  return risky.map((f) => `- **${f.severity.toUpperCase()}** · ${esc(f.message)} (${code(loc(f))}, ${f.id})`).join("\n");
}

function findingsByCategory(inp: RunInputs): string {
  const fs = live(inp);
  const cats = stableSort([...new Set(fs.map((f) => f.category))], (c) => [CATEGORY_ORDER.indexOf(c) === -1 ? 99 : CATEGORY_ORDER.indexOf(c), c]);
  if (cats.length === 0) return "No open findings.";
  return cats.map((c) => {
    const rows = bySeverity(fs.filter((f) => f.category === c)).map((f) => [f.id, f.severity, esc(state(inp, f)), code(`${f.tool}/${f.rule_id}`), code(loc(f)), esc(f.message)]);
    return [`### ${CATEGORY_TITLES[c] ?? esc(c)}`, "", table(["ID", "Severity", "State", "Rule", "Location", "Finding"], rows, [8, 9, 10, 22, 19, 32])].join("\n");
  }).join("\n\n");
}

function coverageSection(inp: RunInputs): string | null {
  const stacks = (inp.metrics["coverage"] as { stacks?: Record<string, { status: string; line_pct: number | null; branch_pct: number | null }> } | undefined)?.stacks;
  if (stacks === undefined || Object.keys(stacks).length === 0) return null;
  const pctText = (v: number | null) => (v === null ? "—" : `${String(v)}%`);
  return table(["Stack", "Result", "Line coverage", "Branch coverage"],
    stableSort(Object.entries(stacks), ([k]) => k).map(([k, m]) => [esc(k), esc(m.status), pctText(m.line_pct), pctText(m.branch_pct)]));
}

function methodology(inp: RunInputs, l: Layout): string {
  const lock = readLock(l.toolchainLock);
  const snaps = readSnapshotsLock(l.snapshotsLock);
  const tools = stableSort(Object.entries(lock.tools), ([k]) => k).map(([k, v]) => `${k} ${v.version}`);
  const laneRows = stableSort([...inp.lanes], ([k]) => k).map(([lane, outcome]) => [esc(lane), esc(outcome)]);
  const dismissed = inp.findings.filter((f) => state(inp, f) === "dismissed").length;
  const waived = inp.findings.filter((f) => state(inp, f) === "waived").length;
  const defs = inp.rubric.definitions;
  const lines = [
    `This review analyzed commit ${code(inp.doc.source.sha)} with a pinned, checksum-verified toolchain. Every finding traces to a specific tool's output (rule id and location). No finding was created or rated by an AI model.`,
    "",
    table(["Item", "Value"], [
      ["Engagement type / tier", esc(`${inp.doc.engagement_type} / ${inp.doc.tier}`)],
      ["Run", esc(`${inp.runId} (${inp.runStatus})`)],
      ["Tools", esc(tools.join(", "))],
      ["Sandbox", lock.sandbox === undefined || lock.sandbox === null ? "none" : esc(`${lock.sandbox.runtime} (pinned images)`)],
      ["Vulnerability data", esc([snaps.osv === null ? "OSV: none" : `OSV ${snaps.osv.id}`, snaps.epss ? `EPSS ${snaps.epss.published}` : "EPSS: none", snaps.kev ? `KEV ${snaps.kev.published}` : "KEV: none"].join("; "))],
      ["Severity rubric", esc(inp.rubric.version)],
      ["AI (LLM) policy", esc(inp.doc.llm_policy)],
      ["Network", esc(`${inp.doc.network.mode} (${inp.doc.network.enforcement})`)],
      ["Dismissed / waived findings", `${String(dismissed)} / ${String(waived)}`],
    ]),
    "",
    "**Lanes**",
    "",
    table(["Lane", "Outcome"], laneRows),
  ];
  if (inp.notes.length > 0) lines.push("", "**Gaps**", "", ...inp.notes.map((n) => `- ${esc(n)}`));
  if (defs !== undefined) {
    lines.push("", "**Severity definitions**", "", table(["Severity", "Meaning"], [...SEVERITIES].reverse().map((s: Severity) => [s, esc(defs[s])]), [14, 86]));
  }
  return lines.join("\n");
}

function appendix(inp: RunInputs): string {
  const rows = bySeverity(inp.findings).map((f) => [f.id, f.severity, esc(state(inp, f)), code(`${f.tool}/${f.rule_id}`), code(loc(f))]);
  return rows.length === 0 ? "No findings." : table(["ID", "Severity", "State", "Rule", "Location"], rows, [10, 12, 12, 34, 32]);
}

function planSummary(waves: readonly PlanWave[]): string {
  const rows = waves.map((w) => [String(w.wave), esc(w.label), String(w.items.length), String(w.items.reduce((n, i) => n + i.findings.length, 0))]);
  return `${table(["Wave", "Focus", "Work items", "Findings"], rows)}\n\nThe full plan, with effort and acceptance criteria, is in the remediation plan.`;
}

export function renderReport(inp: RunInputs, l: Layout, card: Scorecard | undefined, waves: readonly PlanWave[], runDate: string): string {
  const triage = inp.doc.engagement_type === "triage";
  const parts = [
    frontMatter(inp, l, card, runDate),
    "",
    "# Executive summary",
    "",
    keep("executive-summary", "_Write the executive summary here. radr preserves this block when the report is regenerated._"),
  ];
  if (card !== undefined) parts.push("", "# At a glance", "", scorecardSection(card));
  parts.push("", "# Top risks", "", topRisks(inp));
  if (!triage) {
    parts.push("", "# Findings", "", findingsByCategory(inp));
    const cov = coverageSection(inp);
    if (cov !== null) parts.push("", "# Test coverage", "", cov);
    parts.push("", "# Remediation overview", "", planSummary(waves));
    parts.push("", "# Recommendations", "", keep("recommendations", "_Consultant recommendations. Preserved across regeneration._"));
  }
  parts.push("", "# Methodology", "", methodology(inp, l));
  if (!triage) parts.push("", "# Appendix: all findings", "", appendix(inp));
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
    keep("plan-notes", "_Sequencing notes, owners, and constraints. Preserved across regeneration._"),
  ];
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
  return `${parts.join("\n").replace(/\n+$/, "")}\n`;
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
