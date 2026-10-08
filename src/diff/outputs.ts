// PR-review outputs (PRD §13; M6 W4): SARIF 2.1.0 for code-scanning upload, and a Markdown
// summary the consultant posts on the pull request. Both list only the findings the diff run
// surfaced, contain no timestamps, and are canonical, so they're byte-identical across runs,
// homes, TZ and LANG.
//
// The SARIF is validated against SARIF_SCHEMA: the structural subset of SARIF 2.1.0 that radr
// emits (required properties, types, enums). The full OASIS schema isn't vendored.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson, hashBytes, stableSort } from "../core/determinism.js";
import { InternalError } from "../core/errors.js";
import type { EngagementDoc } from "../engagement/config.js";
import type { Layout } from "../engagement/home.js";
import { SEVERITIES, type Finding, type Severity } from "../findings/types.js";
import { makeValidator } from "../schemas/validate.js";

const LEVEL: Readonly<Record<Severity, "error" | "warning" | "note">> = { critical: "error", high: "error", medium: "warning", low: "note", info: "note" };
const str = { type: "string", minLength: 1 } as const;

/** The SARIF 2.1.0 properties radr writes, with the spec's required fields and enums. */
export const SARIF_SCHEMA = {
  type: "object", additionalProperties: false, required: ["$schema", "version", "runs"],
  properties: {
    $schema: { const: "https://json.schemastore.org/sarif-2.1.0.json" },
    version: { const: "2.1.0" },
    runs: {
      type: "array", minItems: 1, maxItems: 1,
      items: {
        type: "object", additionalProperties: false, required: ["tool", "results"],
        properties: {
          tool: {
            type: "object", additionalProperties: false, required: ["driver"],
            properties: {
              driver: {
                type: "object", additionalProperties: false, required: ["name", "rules"],
                properties: {
                  name: str, informationUri: str,
                  rules: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "shortDescription"], properties: { id: str, shortDescription: { type: "object", additionalProperties: false, required: ["text"], properties: { text: str } } } } },
                },
              },
            },
          },
          results: {
            type: "array",
            items: {
              type: "object", additionalProperties: false, required: ["ruleId", "level", "message", "locations", "partialFingerprints", "properties"],
              properties: {
                ruleId: str, level: { enum: ["none", "note", "warning", "error"] },
                message: { type: "object", additionalProperties: false, required: ["text"], properties: { text: str } },
                locations: {
                  type: "array", minItems: 1,
                  items: {
                    type: "object", additionalProperties: false, required: ["physicalLocation"],
                    properties: {
                      physicalLocation: {
                        type: "object", additionalProperties: false, required: ["artifactLocation"],
                        properties: {
                          artifactLocation: { type: "object", additionalProperties: false, required: ["uri"], properties: { uri: str } },
                          region: { type: "object", additionalProperties: false, required: ["startLine"], properties: { startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } } },
                        },
                      },
                    },
                  },
                },
                partialFingerprints: { type: "object", additionalProperties: str, minProperties: 1 },
                properties: { type: "object" },
              },
            },
          },
          properties: { type: "object" },
        },
      },
    },
  },
} as const;
const validateSarif = makeValidator<unknown>(SARIF_SCHEMA, InternalError);

const ruleId = (f: Finding) => `${f.tool}/${f.rule_id}`;
const bySeverity = (fs: readonly Finding[]) => stableSort(fs, (f) => [-SEVERITIES.indexOf(f.severity), f.id]);

export function renderSarif(doc: EngagementDoc, runId: string, findings: readonly Finding[]): string {
  if (doc.diff === undefined) throw new InternalError("SARIF output is for diff scopes");
  const fs = bySeverity(findings);
  const rules = stableSort([...new Map(fs.map((f) => [ruleId(f), f])).values()], ruleId).map((f) => ({ id: ruleId(f), shortDescription: { text: `${f.tool} ${f.rule_id}` } }));
  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: { driver: { name: "radr", informationUri: "https://github.com/seanrreid/RADr", rules } },
      results: fs.map((f) => ({
        ruleId: ruleId(f), level: LEVEL[f.severity], message: { text: f.message === "" ? ruleId(f) : f.message },
        locations: [{ physicalLocation: { artifactLocation: { uri: f.file }, ...(f.line > 0 ? { region: { startLine: f.line, endLine: Math.max(f.line, f.end_line) } } : {}) } }],
        partialFingerprints: { "radr/v1": f.fingerprint },
        properties: { "radr-id": f.id, severity: f.severity, "rubric-version": f.rubric_version, lane: f.lane },
      })),
      properties: { "radr-run": runId, base: doc.diff.base, head: doc.source.sha },
    }],
  };
  validateSarif(sarif, "radr SARIF output");
  return `${canonicalJson(sarif)}\n`;
}

export function renderPrSummary(doc: EngagementDoc, runId: string, findings: readonly Finding[], suppressed: number, gaps: readonly string[] = []): string {
  if (doc.diff === undefined) throw new InternalError("the PR summary is for diff scopes");
  const fs = bySeverity(findings);
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const counts = [...SEVERITIES].reverse().map((s) => [s, fs.filter((f) => f.severity === s).length] as const).filter(([, n]) => n > 0);
  const lines = [
    `## radr review: ${doc.client}/${doc.slug}, ${doc.diff.base.slice(0, 12)}...${doc.source.sha.slice(0, 12)}`,
    "",
    fs.length === 0 ? "No new findings in this change." : `**${String(fs.length)} new finding(s)**: ${counts.map(([s, n]) => `${String(n)} ${s}`).join(", ")}.`,
  ];
  if (fs.length > 0) {
    lines.push("", "| Severity | Rule | Location | Finding |", "| --- | --- | --- | --- |");
    for (const f of fs) lines.push(`| ${f.severity} | \`${esc(ruleId(f))}\` | \`${esc(f.line > 0 ? `${f.file}:${String(f.line)}` : f.file)}\` | ${esc(f.message)} |`);
  }
  // "No new findings" only means what was assessed: say what wasn't (dogfood 2026-10-08).
  if (gaps.length > 0) lines.push("", "**Not assessed in this review:**", "", ...gaps.map((g) => `- ${esc(g)}`));
  lines.push("", `<sub>radr ${runId} · rubric ${doc.rubric} · only findings in files this change touches, and not in the baseline (${String(suppressed)} suppressed). Severity comes from the rubric, not from an AI model.</sub>`);
  return `${lines.join("\n")}\n`;
}

/** Write both outputs under review/; returns their refs and hashes for the run-completed event. */
export function writePrOutputs(l: Layout, doc: EngagementDoc, runId: string, findings: readonly Finding[], suppressed: number, gaps: readonly string[] = []): { ref: string; hash: string }[] {
  const dir = path.join(l.dir, "review");
  mkdirSync(dir, { recursive: true });
  const stem = `pr-${doc.source.sha.slice(0, 12)}`;
  return [[`${stem}.sarif`, renderSarif(doc, runId, findings)], [`${stem}.md`, renderPrSummary(doc, runId, findings, suppressed, gaps)]].map(([name = "", body = ""]) => {
    writeFileSync(path.join(dir, name), body);
    return { ref: `review/${name}`, hash: hashBytes(body) };
  });
}
