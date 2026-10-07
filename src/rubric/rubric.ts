// Rubric loader + severity mapping (T5.3, AC14). Severity is computed here and only here;
// the LLM lane (M4) can never write it (PRD §9).

import { readAsset } from "../core/assets.js";
import { InternalError, RefusedError, UsageError } from "../core/errors.js";
import { parseYaml } from "../core/yaml.js";
import { SEVERITIES, type FindingDraft, type Severity } from "../findings/types.js";
import { makeValidator } from "../schemas/validate.js";

interface RubricV0 {
  readonly version: 0;
  readonly base: Readonly<Record<string, Readonly<Record<string, Severity | "from-cvss">>>>;
  readonly cvss_bands_x10: readonly { readonly min: number; readonly severity: Severity }[];
}

const validate = makeValidator<RubricV0>(
  {
    type: "object",
    additionalProperties: false,
    required: ["version", "base", "cvss_bands_x10"],
    properties: {
      version: { const: 0 },
      base: { type: "object", additionalProperties: { type: "object", additionalProperties: { enum: [...SEVERITIES, "from-cvss"] } } },
      cvss_bands_x10: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["min", "severity"],
          properties: { min: { type: "integer", minimum: 0, maximum: 100 }, severity: { enum: SEVERITIES } },
        },
      },
    },
  },
  InternalError,
);

export interface Rubric {
  readonly version: string;
  severityOf(d: FindingDraft): Severity;
}

/** "7.2" → 72. Strict: one optional decimal digit, 0.0–10.0. */
export function cvssTenths(score: string): number {
  const m = /^(\d{1,2})(?:\.(\d))?$/.exec(score);
  const whole = m?.[1];
  if (whole === undefined) throw new RefusedError(`invalid CVSS score "${score}"`);
  const v = Number.parseInt(whole, 10) * 10 + Number.parseInt(m?.[2] ?? "0", 10);
  if (v > 100) throw new RefusedError(`CVSS score out of range "${score}"`);
  return v;
}

export function loadRubric(version: string): Rubric {
  if (version !== "v0") throw new UsageError(`rubric ${version} is not available in M1 (rubric v1 lands in M2; use "v0")`);
  const doc = validate(parseYaml(readAsset("rubric/v0.yml"), "rubric/v0.yml"), "rubric/v0.yml");
  const bands = [...doc.cvss_bands_x10].sort((a, b) => b.min - a.min);
  return {
    version: "v0",
    severityOf(d) {
      const toolMap = Object.hasOwn(doc.base, d.tool) ? doc.base[d.tool] : undefined;
      const mapped = toolMap !== undefined && Object.hasOwn(toolMap, d.tool_severity) ? toolMap[d.tool_severity] : undefined;
      if (mapped === undefined) throw new RefusedError(`rubric v0 has no mapping for (${d.tool}, ${d.tool_severity}); refusing to default`);
      if (mapped !== "from-cvss") return mapped;
      if (d.cvss === null) throw new RefusedError(`(${d.tool}, ${d.rule_id}) maps from CVSS but has no score`);
      const tenths = cvssTenths(d.cvss);
      const band = bands.find((b) => tenths >= b.min);
      if (band === undefined) throw new InternalError("rubric v0: cvss bands do not cover 0");
      return band.severity;
    },
  };
}
