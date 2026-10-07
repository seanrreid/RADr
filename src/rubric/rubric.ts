// Rubric loader + severity assessment (M1 AC14, M2 AC1). Severity is computed here and only
// here; the LLM lane (M4) can never write it (PRD §9).
//
// v1 pipeline: base → rule override → vulnerability promotion (KEV, EPSS) → path modifiers
// (each ±1 step, clamped). Every input that fired is recorded on the finding (epss_bp, kev).

import { readAsset } from "../core/assets.js";
import { InternalError, RefusedError, UsageError } from "../core/errors.js";
import { matchesAny } from "../core/glob.js";
import { parseYaml } from "../core/yaml.js";
import { SEVERITIES, type Category, type FindingDraft, type Severity } from "../findings/types.js";
import { makeValidator } from "../schemas/validate.js";

/** EPSS/KEV lookups. `undefined` = no snapshot pinned (fail-open: no promotion, recorded as null). */
export interface VulnContext {
  epssBp(cve: string): number | null | undefined;
  kev(cve: string): boolean | undefined;
}
export const NO_VULN_CONTEXT: VulnContext = { epssBp: () => undefined, kev: () => undefined };

export interface Assessment {
  readonly severity: Severity;
  readonly epss_bp: number | null;
  readonly kev: boolean | null;
}

export interface Routing {
  readonly auto_confirm: { readonly lanes: readonly string[]; readonly max_severity: Severity; readonly sca_requires_cve: boolean };
  readonly review_set: { readonly lanes: readonly string[]; readonly classes: readonly string[]; readonly min_severity: Severity };
}

export interface ScorecardSpec {
  readonly metrics: Readonly<Record<string, { readonly better: "lower" | "higher"; readonly green: number; readonly red: number; readonly label: string }>>;
  readonly categorical: Readonly<Record<string, { readonly label: string; readonly green: string; readonly amber: string; readonly red: string }>>;
  readonly verdict: {
    readonly at_risk: { readonly red_in: readonly string[]; readonly reds_at_least: number };
    readonly needs_attention: { readonly reds_at_least: number; readonly ambers_at_least: number };
  };
}

export interface Rubric {
  readonly version: string;
  assess(d: FindingDraft, vulns: VulnContext): Assessment;
  /** v1+: disposition routing, scorecard, effort, definitions. */
  readonly routing?: Routing;
  readonly scorecard?: ScorecardSpec;
  readonly effort?: { readonly sizes: Readonly<Record<string, string>>; readonly by_kind: Readonly<Record<string, string>> };
  readonly definitions?: Readonly<Record<Severity, string>>;
}

const sevEnum = { enum: [...SEVERITIES] };
const band = {
  type: "object", additionalProperties: false, required: ["min", "severity"],
  properties: { min: { type: "integer", minimum: 0, maximum: 100 }, severity: sevEnum },
};
const baseMap = { type: "object", additionalProperties: { type: "object", additionalProperties: { enum: [...SEVERITIES, "from-cvss"] } } };

interface DocV0 {
  readonly version: 0;
  readonly base: Readonly<Record<string, Readonly<Record<string, Severity | "from-cvss">>>>;
  readonly cvss_bands_x10: readonly { readonly min: number; readonly severity: Severity }[];
}

interface DocV1 extends Omit<DocV0, "version"> {
  readonly version: 1;
  readonly severities: readonly Severity[];
  readonly definitions: Readonly<Record<Severity, string>>;
  readonly rule_overrides: Readonly<Record<string, Readonly<Record<string, Severity>>>>;
  readonly promote: { readonly kev_listed: Severity; readonly epss_bp_at_least: number };
  readonly path_modifiers: Readonly<Record<"demote" | "promote", { readonly globs: readonly string[]; readonly categories: readonly Category[] }>>;
  readonly disposition: Routing;
  readonly scorecard: ScorecardSpec;
  readonly effort: { readonly sizes: Readonly<Record<string, string>>; readonly by_kind: Readonly<Record<string, string>> };
}

const validateV0 = makeValidator<DocV0>(
  { type: "object", additionalProperties: false, required: ["version", "base", "cvss_bands_x10"],
    properties: { version: { const: 0 }, base: baseMap, cvss_bands_x10: { type: "array", minItems: 1, items: band } } },
  InternalError,
);

const strList = { type: "array", items: { type: "string" } };
const modifier = { type: "object", additionalProperties: false, required: ["globs", "categories"], properties: { globs: strList, categories: strList } };
const validateV1 = makeValidator<DocV1>(
  {
    type: "object", additionalProperties: false,
    required: ["version", "severities", "definitions", "base", "rule_overrides", "cvss_bands_x10", "promote", "path_modifiers", "disposition", "scorecard", "effort"],
    properties: {
      version: { const: 1 },
      severities: { type: "array", items: sevEnum },
      definitions: { type: "object", additionalProperties: false, required: [...SEVERITIES], properties: Object.fromEntries(SEVERITIES.map((s) => [s, { type: "string" }])) },
      base: baseMap,
      rule_overrides: { type: "object", additionalProperties: { type: "object", additionalProperties: sevEnum } },
      cvss_bands_x10: { type: "array", minItems: 1, items: band },
      promote: { type: "object", additionalProperties: false, required: ["kev_listed", "epss_bp_at_least"],
        properties: { kev_listed: sevEnum, epss_bp_at_least: { type: "integer", minimum: 1, maximum: 10000 } } },
      path_modifiers: { type: "object", additionalProperties: false, required: ["demote", "promote"], properties: { demote: modifier, promote: modifier } },
      disposition: {
        type: "object", additionalProperties: false, required: ["auto_confirm", "review_set"],
        properties: {
          auto_confirm: { type: "object", additionalProperties: false, required: ["lanes", "max_severity", "sca_requires_cve"],
            properties: { lanes: strList, max_severity: sevEnum, sca_requires_cve: { type: "boolean" } } },
          review_set: { type: "object", additionalProperties: false, required: ["lanes", "classes", "min_severity"],
            properties: { lanes: strList, classes: strList, min_severity: sevEnum } },
        },
      },
      scorecard: {
        type: "object", additionalProperties: false, required: ["metrics", "categorical", "verdict"],
        properties: {
          metrics: { type: "object", additionalProperties: { type: "object", additionalProperties: false, required: ["better", "green", "red", "label"],
            properties: { better: { enum: ["lower", "higher"] }, green: { type: "integer" }, red: { type: "integer" }, label: { type: "string" } } } },
          categorical: { type: "object", additionalProperties: { type: "object", additionalProperties: false, required: ["label", "green", "amber", "red"],
            properties: { label: { type: "string" }, green: { type: "string" }, amber: { type: "string" }, red: { type: "string" } } } },
          verdict: { type: "object", additionalProperties: false, required: ["at_risk", "needs_attention"],
            properties: {
              at_risk: { type: "object", additionalProperties: false, required: ["red_in", "reds_at_least"], properties: { red_in: strList, reds_at_least: { type: "integer", minimum: 1 } } },
              needs_attention: { type: "object", additionalProperties: false, required: ["reds_at_least", "ambers_at_least"],
                properties: { reds_at_least: { type: "integer", minimum: 1 }, ambers_at_least: { type: "integer", minimum: 1 } } },
            } },
        },
      },
      effort: { type: "object", additionalProperties: false, required: ["sizes", "by_kind"],
        properties: { sizes: { type: "object", additionalProperties: { type: "string" } }, by_kind: { type: "object", additionalProperties: { enum: ["S", "M", "L"] } } } },
    },
  },
  InternalError,
);

/** "7.2" → 72. Strict: one optional decimal digit, 0.0–10.0. */
export function cvssTenths(score: string): number {
  const m = /^(\d{1,2})(?:\.(\d))?$/.exec(score);
  const whole = m?.[1];
  if (whole === undefined) throw new RefusedError(`invalid CVSS score "${score}"`);
  const v = Number.parseInt(whole, 10) * 10 + Number.parseInt(m?.[2] ?? "0", 10);
  if (v > 100) throw new RefusedError(`CVSS score out of range "${score}"`);
  return v;
}

export const sevRank = (s: Severity): number => SEVERITIES.indexOf(s);
const step = (s: Severity, by: number): Severity => SEVERITIES[Math.max(0, Math.min(SEVERITIES.length - 1, sevRank(s) + by))] ?? s;
const atLeast = (s: Severity, floor: Severity): Severity => (sevRank(s) >= sevRank(floor) ? s : floor);

function baseSeverity(doc: DocV0 | DocV1, d: FindingDraft, version: string): Severity {
  const toolMap = Object.hasOwn(doc.base, d.tool) ? doc.base[d.tool] : undefined;
  const mapped = toolMap !== undefined && Object.hasOwn(toolMap, d.tool_severity) ? toolMap[d.tool_severity] : undefined;
  if (mapped === undefined) throw new RefusedError(`rubric ${version} has no mapping for (${d.tool}, ${d.tool_severity}); refusing to default`);
  if (mapped !== "from-cvss") return mapped;
  if (d.cvss === null) throw new RefusedError(`(${d.tool}, ${d.rule_id}) maps from CVSS but has no score`);
  const tenths = cvssTenths(d.cvss);
  const b = [...doc.cvss_bands_x10].sort((x, y) => y.min - x.min).find((x) => tenths >= x.min);
  if (b === undefined) throw new InternalError(`rubric ${version}: cvss bands do not cover ${d.cvss}`);
  return b.severity;
}

function rubricV0(doc: DocV0): Rubric {
  return { version: "v0", assess: (d) => ({ severity: baseSeverity(doc, d, "v0"), epss_bp: null, kev: null }) };
}

function rubricV1(doc: DocV1): Rubric {
  return {
    version: "v1",
    routing: doc.disposition,
    scorecard: doc.scorecard,
    effort: doc.effort,
    definitions: doc.definitions,
    assess(d, vulns) {
      let severity = baseSeverity(doc, d, "v1");
      const override = Object.hasOwn(doc.rule_overrides, d.tool) ? doc.rule_overrides[d.tool] : undefined;
      if (override !== undefined && Object.hasOwn(override, d.rule_id)) severity = override[d.rule_id] ?? severity;

      let epss: number | null = null;
      let kev: boolean | null = null;
      if (d.cve !== null) {
        const e = vulns.epssBp(d.cve);
        const k = vulns.kev(d.cve);
        epss = e === undefined ? null : e;
        kev = k === undefined ? null : k;
        if (kev === true) severity = atLeast(severity, doc.promote.kev_listed);
        if (epss !== null && epss >= doc.promote.epss_bp_at_least) severity = step(severity, 1);
      }

      const { demote, promote } = doc.path_modifiers;
      if (demote.categories.includes(d.category) && matchesAny(d.file, demote.globs)) severity = step(severity, -1);
      if (promote.categories.includes(d.category) && matchesAny(d.file, promote.globs)) severity = step(severity, 1);
      return { severity, epss_bp: epss, kev };
    },
  };
}

export function loadRubric(version: string): Rubric {
  if (version === "v0") return rubricV0(validateV0(parseYaml(readAsset("rubric/v0.yml"), "rubric/v0.yml"), "rubric/v0.yml"));
  if (version === "v1") return rubricV1(validateV1(parseYaml(readAsset("rubric/v1.yml"), "rubric/v1.yml"), "rubric/v1.yml"));
  throw new UsageError(`unknown rubric "${version}" (available: v0, v1)`);
}

/** Is this finding in the always-human review set (PRD §8)? */
export function inReviewSet(r: Routing, f: { lane: string; class: string; severity: Severity }): boolean {
  return r.review_set.lanes.includes(f.lane) || r.review_set.classes.includes(f.class) || sevRank(f.severity) >= sevRank(r.review_set.min_severity);
}

/** Should the rubric auto-confirm this (pending) finding? Never for the review set. */
export function autoConfirms(r: Routing, f: { lane: string; class: string; severity: Severity; cve: string | null }): boolean {
  if (inReviewSet(r, f)) return false;
  const a = r.auto_confirm;
  if (!a.lanes.includes(f.lane) || sevRank(f.severity) > sevRank(a.max_severity)) return false;
  return !(f.lane === "sca" && a.sca_requires_cve && f.cve === null);
}
