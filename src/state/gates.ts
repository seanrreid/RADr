// Gate evaluation: a pure fold over the event log against policy/gates.yml (M1 AC8 unit level).

import { readAsset } from "../core/assets.js";
import { InternalError } from "../core/errors.js";
import { parseYaml } from "../core/yaml.js";
import { EVENT_TYPES, type EventType } from "../schemas/events.js";
import { makeValidator } from "../schemas/validate.js";
import type { Event } from "./events.js";

interface GateRule {
  readonly eventType: EventType;
  readonly condition: "latest-fingerprint-equals";
  readonly reason: string;
}

interface GatesDoc {
  readonly version: 1;
  readonly gates: Readonly<Record<string, GateRule>>;
}

const validateDoc = makeValidator<GatesDoc>(
  {
    type: "object",
    additionalProperties: false,
    required: ["version", "gates"],
    properties: {
      version: { const: 1 },
      gates: {
        type: "object",
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          required: ["eventType", "condition", "reason"],
          properties: {
            eventType: { enum: EVENT_TYPES },
            condition: { enum: ["latest-fingerprint-equals"] },
            reason: { type: "string", minLength: 1 },
          },
        },
      },
    },
  },
  InternalError,
);

export interface GateContext {
  /** Fingerprint of the current scope, computed fresh by the caller. */
  readonly fingerprint: string;
}

export interface GateResult {
  readonly gate: string;
  readonly passed: boolean;
  readonly reason: string;
  /** The event that satisfied (or most recently failed to satisfy) the gate. */
  readonly event?: Event;
}

export class Gates {
  private constructor(private readonly doc: GatesDoc) {}

  static fromYaml(text: string, source: string): Gates {
    return new Gates(validateDoc(parseYaml(text, source), source));
  }

  static load(): Gates {
    return Gates.fromYaml(readAsset("policy/gates.yml"), "policy/gates.yml");
  }

  evaluate(name: string, events: readonly Event[], ctx: GateContext): GateResult {
    const rule = Object.hasOwn(this.doc.gates, name) ? this.doc.gates[name] : undefined;
    if (rule === undefined) throw new InternalError(`unknown gate "${name}"`);
    const latest = events.findLast((e) => e.type === rule.eventType);
    if (latest === undefined) return { gate: name, passed: false, reason: rule.reason };
    const approved = latest.data["fingerprint"];
    if (approved !== ctx.fingerprint) {
      return {
        gate: name,
        passed: false,
        reason: `scope changed since approval (approved ${String(approved)}, current ${ctx.fingerprint}); ${rule.reason}`,
        event: latest,
      };
    }
    return { gate: name, passed: true, reason: "ok", event: latest };
  }
}
