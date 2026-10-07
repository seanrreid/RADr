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
const obj = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)): AnySchema => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
});

/** Payload schema per event type. Adding an event type means adding it here. */
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
    },
    ["run_id", "lane", "attempt", "outcome", "action", "tools"],
  ),
  "run-completed": obj(
    { run_id: runId, status: { enum: ["complete", "partial", "aborted"] }, findings_set_hash: sha, notes: { type: "array", items: { type: "string" } }, auto_confirmed: { type: "integer", minimum: 0 } },
    ["run_id", "status"],
  ),
  "finding-disposition": obj(
    { finding_id: { type: "string", pattern: "^F-[0-9]{4,}$" }, from: str, to: str, reason: { type: "string" } },
    ["finding_id", "from", "to"],
  ),
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
