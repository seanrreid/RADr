// engagement.yml: the human-reviewed scope (PRD §7 Gate 1). Written by `radr scope`, edited by
// the consultant, frozen by `radr approve scope`. Unknown keys are errors, not ignored.

import { readFileSync, writeFileSync } from "node:fs";
import { stringify } from "yaml";
import { UsageError } from "../core/errors.js";
import { parseYaml } from "../core/yaml.js";
import { GIT_SHA, SLUG, makeValidator } from "../schemas/validate.js";

export const ENGAGEMENT_TYPES = ["triage", "quality", "health-audit", "security", "due-diligence", "pr-review", "debug"] as const;
export const TIERS = ["triage", "standard", "deep", "diff"] as const;
/** Lanes implemented in M1. Later milestones extend this list (and policy/matrix.yml). */
export const LANES = ["census", "lint", "secrets", "sca"] as const;
export const STACKS = ["typescript-javascript", "python"] as const;

export interface EngagementDoc {
  readonly version: 1;
  readonly client: string;
  readonly slug: string;
  readonly engagement_type: (typeof ENGAGEMENT_TYPES)[number];
  readonly tier: (typeof TIERS)[number];
  readonly source: { readonly origin: string; readonly sha: string };
  readonly paths: { readonly include: readonly string[]; readonly exclude: readonly string[] };
  readonly stacks: readonly (typeof STACKS)[number][];
  readonly lanes: readonly (typeof LANES)[number][];
  readonly rubric: string;
  readonly network: { readonly mode: "offline" | "network"; readonly enforcement: "declared" | "container" };
  readonly llm_policy: "off" | "metadata-only" | "code-allowed";
  readonly client_licenses: readonly string[];
}

const strArray = { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true } as const;

const validate = makeValidator<EngagementDoc>(
  {
    type: "object",
    additionalProperties: false,
    required: ["version", "client", "slug", "engagement_type", "tier", "source", "paths", "stacks", "lanes", "rubric", "network", "llm_policy", "client_licenses"],
    properties: {
      version: { const: 1 },
      client: { type: "string", pattern: SLUG },
      slug: { type: "string", pattern: SLUG },
      engagement_type: { enum: ENGAGEMENT_TYPES },
      tier: { enum: TIERS },
      source: {
        type: "object",
        additionalProperties: false,
        required: ["origin", "sha"],
        properties: { origin: { type: "string", minLength: 1 }, sha: { type: "string", pattern: GIT_SHA } },
      },
      paths: {
        type: "object",
        additionalProperties: false,
        required: ["include", "exclude"],
        properties: { include: { ...strArray, minItems: 1 }, exclude: strArray },
      },
      stacks: { type: "array", items: { enum: STACKS }, uniqueItems: true },
      lanes: { type: "array", items: { enum: LANES }, uniqueItems: true, minItems: 1 },
      rubric: { type: "string", pattern: "^v[0-9]+$" },
      network: {
        type: "object",
        additionalProperties: false,
        required: ["mode", "enforcement"],
        properties: { mode: { enum: ["offline", "network"] }, enforcement: { enum: ["declared", "container"] } },
      },
      llm_policy: { enum: ["off", "metadata-only", "code-allowed"] },
      client_licenses: strArray,
    },
  },
  UsageError,
);

export function parseEngagement(text: string, source: string): EngagementDoc {
  const doc = validate(parseYaml(text, source), source);
  if (doc.llm_policy !== "off") {
    throw new UsageError(`${source}: llm_policy "${doc.llm_policy}" is not available until M4; use "off"`);
  }
  if (doc.network.enforcement === "container") {
    throw new UsageError(`${source}: network enforcement "container" requires container mode (M3); use "declared"`);
  }
  return doc;
}

export function loadEngagement(file: string): EngagementDoc {
  return parseEngagement(readFileSync(file, "utf8"), file);
}

const HEADER = `# engagement.yml: the scope for this engagement (PRD §7, Gate 1).
# Review and edit, then run \`radr approve scope\`. Every field here is part of the scope
# fingerprint: changing anything after approval closes the gate until it is re-approved.
`;

export function writeEngagement(file: string, doc: EngagementDoc): void {
  writeFileSync(file, HEADER + stringify(doc, { lineWidth: 0 }));
}
