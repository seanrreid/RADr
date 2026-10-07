// Disposition state machine (PRD §8, T5.5, AC15). State is a fold over finding-disposition
// events; transitions outside the table are rejected, and reasons are mandatory where the PRD
// requires them.
//
// Judgment findings (J-NNNN, M4) start in `proposed`: the LLM proposed them and no person has
// looked yet. Only a consultant moves one to `pending` (accepting it for review) or dismisses it.

import { RefusedError } from "../core/errors.js";
import type { Event } from "../state/events.js";

export type DispositionState = "proposed" | "pending" | "confirmed" | "dismissed" | "waived" | "fixed" | "verified" | "regressed";

/** from → allowed targets. `fixed`/`verified`/`regressed` are written by `radr verify` (M6). */
const TRANSITIONS: Readonly<Record<DispositionState, readonly DispositionState[]>> = {
  proposed: ["pending", "dismissed"],
  pending: ["confirmed", "dismissed", "waived"],
  confirmed: ["fixed", "waived"],
  dismissed: [],
  waived: [],
  fixed: ["verified", "regressed"],
  verified: ["regressed"],
  regressed: ["confirmed"],
};

/** Targets a consultant may set by hand (`pending` only from `proposed`, per TRANSITIONS). */
export const MANUAL_TARGETS: readonly DispositionState[] = ["pending", "confirmed", "dismissed", "waived"];
const REASON_REQUIRED: readonly DispositionState[] = ["dismissed", "waived"];

export function dispositions(events: readonly Event[]): Map<string, DispositionState> {
  const states = new Map<string, DispositionState>();
  for (const e of events) {
    if (e.type !== "finding-disposition") continue;
    states.set(String(e.data["finding_id"]), e.data["to"] as DispositionState);
  }
  return states;
}

export function stateOf(states: ReadonlyMap<string, DispositionState>, id: string): DispositionState {
  return states.get(id) ?? initialState(id);
}

/** Tool findings start pending; judgment findings (J-…) start proposed. */
export function initialState(id: string): DispositionState {
  return id.startsWith("J-") ? "proposed" : "pending";
}

export function checkTransition(from: DispositionState, to: DispositionState, reason: string | undefined): void {
  if (!MANUAL_TARGETS.includes(to)) throw new RefusedError(`"${to}" can't be set by hand (allowed: ${MANUAL_TARGETS.join(", ")})`);
  if (!TRANSITIONS[from].includes(to)) throw new RefusedError(`illegal transition ${from} → ${to}`);
  if (REASON_REQUIRED.includes(to) && (reason === undefined || reason.trim() === "")) throw new RefusedError(`${to} requires --reason`);
}

export function isState(s: string): s is DispositionState {
  return Object.hasOwn(TRANSITIONS, s);
}
