// Event envelope + per-type payload schemas. The event log is the authority (PRD P3), so an
// event of an unknown type, or with an unexpected field, is rejected on write AND on read.

import type { AnySchema } from "ajv";
import { RefusedError } from "../core/errors.js";
import { GIT_SHA, ISO_UTC, SHA256, SLUG, makeValidator, type Validator } from "./validate.js";

export const GENESIS = "genesis";

export interface EventEnvelope<D = Record<string, unknown>> {
  readonly v: 1;
  readonly seq: number;
  readonly type: EventType;
  readonly at: string;
  readonly actor: string;
  readonly data: D;
  readonly prev: string;
  readonly hash: string;
}

const str = { type: "string", minLength: 1 } as const;
const sha = { type: "string", pattern: SHA256 } as const;
const runId = { type: "string", pattern: "^R-[0-9]{4}$" } as const;
const laneId = { type: "string", pattern: SLUG } as const;
const FINDING_ID = "^[FJ]-[0-9]{4,}$";
const SEVERITY_ENUM = ["info", "low", "medium", "high", "critical"];
const DEBUG_ID = { type: "string", pattern: "^D-[0-9]{4,}$" } as const;
const HYPOTHESIS_ID = { type: "string", pattern: "^H-[0-9]{4,}$" } as const;
const obj = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)): AnySchema => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
});

/**
 * Payload schema per event type. Adding an event type means adding it here.
 * EVOLUTION RULE: the log is append-only and must stay readable forever, so schema changes are
 * ADDITIVE ONLY: new fields are optional, existing fields never change type or become required.
 */
const PAYLOADS = {
  "engagement-created": obj({ client: { type: "string", pattern: SLUG }, slug: { type: "string", pattern: SLUG }, salt_hash: sha }),
  "source-mirrored": obj({ source: str, refs_hash: sha }),
  "source-fetched": obj({ refs_hash: sha, refs: { type: "array", items: str } }),
  "scope-proposed": obj({ fingerprint: sha, engagement_hash: sha }),
  "scope-approved": obj({ fingerprint: sha, sha: { type: "string", pattern: GIT_SHA } }),
  "toolchain-locked": obj({ lock_hash: sha, mode: { enum: ["host", "container"] } }),
  "run-started": obj({ run_id: runId, fingerprint: sha, tier: str, lanes: { type: "array", items: laneId } }),
  "lane-started": obj({ run_id: runId, lane: laneId, attempt: { type: "integer", minimum: 1 } }),
  "lane-completed": obj(
    {
      run_id: runId,
      lane: laneId,
      attempt: { type: "integer", minimum: 1 },
      outcome: str,
      action: str,
      tools: {
        type: "array",
        items: obj(
          { tool: str, exit_code: { type: ["integer", "null"] }, stdout_hash: sha, stderr_hash: sha, raw_ref: str },
          ["tool", "exit_code", "stdout_hash", "stderr_hash"],
        ),
      },
      detail: { type: "string" },
      metrics_ref: str,
      metrics_hash: sha,
    },
    ["run_id", "lane", "attempt", "outcome", "action", "tools"],
  ),
  "run-completed": obj(
    { run_id: runId, status: { enum: ["complete", "partial", "aborted"] }, findings_set_hash: sha, notes: { type: "array", items: { type: "string" } }, auto_confirmed: { type: "integer", minimum: 0 } },
    ["run_id", "status"],
  ),
  "report-generated": obj({ run_id: runId, findings_set_hash: sha, report_hash: sha, remediation_hash: sha }),
  "report-approved": obj(
    { run_id: runId, findings_set_hash: sha, dispositions_hash: sha, report_hash: sha, remediation_hash: sha, theme: { type: "string", pattern: SLUG }, theme_hash: sha, accepted_partial: str },
    // dispositions_hash is NOT required: it was added after the first approvals were recorded.
    ["run_id", "findings_set_hash", "report_hash", "remediation_hash", "theme", "theme_hash"],
  ),
  // One agent invocation (PRD §9). The prompt and response files under llm/ hash to these values.
  "llm-call": obj(
    {
      call_id: { type: "string", pattern: "^L-[0-9]{4,}$" },
      purpose: { type: "string", pattern: SLUG },
      policy: { enum: ["metadata-only", "code-allowed"] },
      attempt: { type: "integer", minimum: 1 },
      argv_hash: sha,
      prompt_hash: sha,
      response_hash: sha,
      outcome: str,
      action: str,
      detail: { type: "string" },
    },
    ["call_id", "purpose", "policy", "attempt", "argv_hash", "prompt_hash", "response_hash", "outcome", "action"],
  ),
  // finding_id: F- (tool findings); J- (judgment findings) since M4. Widening a pattern is
  // additive: every older event still validates.
  // --- M5: Debug (PRD §11). One debug is D-NNNN; its runs DR-NNNN; its hypotheses H-NNNN. ---
  "debug-opened": obj(
    {
      debug_id: DEBUG_ID, from: { enum: ["issue", "finding"] }, finding_id: { type: "string", pattern: FINDING_ID },
      symptom: str, expected: str, actual: str, environment: str, first_seen: str, commit: { type: "string", pattern: GIT_SHA },
    },
    ["debug_id", "from", "symptom", "commit"],
  ),
  // A sandbox run of the debug's own scripts: the repro, an experiment, a bisect step, or a
  // regression-guard run. outcome follows the git-bisect-run contract (see src/debug/state.ts).
  "debug-run": obj(
    {
      debug_id: DEBUG_ID, run_id: { type: "string", pattern: "^DR-[0-9]{4,}$" },
      kind: { enum: ["repro", "experiment", "bisect", "guard-without-fix", "guard-with-fix"] },
      commit: { type: "string", pattern: GIT_SHA }, script_hash: sha, exit_code: { type: ["integer", "null"] },
      outcome: { enum: ["present", "absent", "skip", "error"] }, log_ref: str, log_hash: sha,
      hypothesis_id: HYPOTHESIS_ID, detail: { type: "string" },
      // Guard runs: hashes of the patches applied on top of `commit` (test patch, fix patch).
      patch_hashes: { type: "array", items: sha },
    },
    ["debug_id", "run_id", "kind", "commit", "script_hash", "exit_code", "outcome", "log_ref", "log_hash"],
  ),
  "debug-bisected": obj(
    {
      debug_id: DEBUG_ID, good: { type: "string", pattern: GIT_SHA }, bad: { type: "string", pattern: GIT_SHA },
      // The first bad commit, or the candidates it must be one of when commits were skipped.
      first_bad: { type: "array", minItems: 1, items: { type: "string", pattern: GIT_SHA } },
      runs: { type: "array", items: { type: "string", pattern: "^DR-[0-9]{4,}$" } },
    },
  ),
  "hypothesis-proposed": obj(
    { debug_id: DEBUG_ID, hypothesis_id: HYPOTHESIS_ID, text: str, source: { enum: ["consultant", "llm"] }, call_id: { type: "string", pattern: "^L-[0-9]{4,}$" } },
    ["debug_id", "hypothesis_id", "text", "source"],
  ),
  "hypothesis-decided": obj({
    debug_id: DEBUG_ID, hypothesis_id: HYPOTHESIS_ID, to: { enum: ["confirmed", "refuted"] },
    run_id: { type: "string", pattern: "^DR-[0-9]{4,}$" }, reason: str,
  }),
  "debug-concluded": obj(
    {
      debug_id: DEBUG_ID, outcome: { enum: ["root-caused", "cannot-reproduce"] }, hypothesis_id: HYPOTHESIS_ID,
      introducing_commit: { type: "string", pattern: GIT_SHA }, summary: str,
      // Add a "Debug fixes" item to the remediation plan (PRD §11 step 7).
      to_plan: { type: "boolean" },
    },
    ["debug_id", "outcome", "summary"],
  ),
  "finding-disposition": obj(
    { finding_id: { type: "string", pattern: FINDING_ID }, from: str, to: str, reason: { type: "string" } },
    ["finding_id", "from", "to"],
  ),
  // M4: a judgment finding proposed by the LLM lane. judgments.jsonl holds the record; its
  // canonical-JSON hash is frozen here.
  "finding-proposed": obj({
    finding_id: { type: "string", pattern: "^J-[0-9]{4,}$" }, run_id: runId,
    call_id: { type: "string", pattern: "^L-[0-9]{4,}$" }, record_hash: sha,
  }),
  // M4: a consultant's severity decision (PRD §10). Not a state transition; the reason is required.
  "severity-override": obj({
    finding_id: { type: "string", pattern: FINDING_ID }, from: { enum: SEVERITY_ENUM }, to: { enum: SEVERITY_ENUM }, reason: str,
  }),
} as const satisfies Record<string, AnySchema>;

export type EventType = keyof typeof PAYLOADS;
export const EVENT_TYPES = Object.keys(PAYLOADS) as EventType[];

const envelope: Validator<EventEnvelope> = makeValidator<EventEnvelope>(
  obj({
    v: { const: 1 },
    seq: { type: "integer", minimum: 1 },
    type: { enum: EVENT_TYPES },
    at: { type: "string", pattern: ISO_UTC },
    actor: str,
    data: { type: "object" },
    prev: { anyOf: [{ const: GENESIS }, sha] },
    hash: sha,
  }),
  RefusedError,
);

const payloadValidators = Object.fromEntries(
  Object.entries(PAYLOADS).map(([type, schema]) => [type, makeValidator(schema, RefusedError)]),
) as Record<EventType, Validator<Record<string, unknown>>>;

export function isEventType(t: string): t is EventType {
  return Object.hasOwn(PAYLOADS, t);
}

export function validatePayload(type: EventType, data: unknown, where: string): Record<string, unknown> {
  return payloadValidators[type](data, `${where} (${type} data)`);
}

export function validateEvent(value: unknown, where: string): EventEnvelope {
  const e = envelope(value, where);
  validatePayload(e.type, e.data, where);
  return e;
}
