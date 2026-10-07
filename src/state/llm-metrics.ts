// LLM signal quality (PRD §18), folded from the event log: how often the agent returned a
// schema-valid response, and how many proposed judgment findings a person kept.

import { dispositions } from "../findings/disposition.js";
import type { Event } from "./events.js";

export interface LlmMetrics {
  readonly calls: number;
  readonly succeeded: number;
  readonly failProtocol: number;
  readonly judgmentsProposed: number;
  /** Judgment findings a person confirmed or waived. */
  readonly judgmentsKept: number;
  readonly judgmentsDismissed: number;
}

export function llmMetrics(events: readonly Event[]): LlmMetrics {
  const calls = events.filter((e) => e.type === "llm-call");
  const proposed = events.filter((e) => e.type === "finding-proposed").map((e) => String(e.data["finding_id"]));
  const states = dispositions(events);
  const count = (ss: readonly string[]) => proposed.filter((id) => ss.includes(states.get(id) ?? "proposed")).length;
  return {
    calls: calls.length,
    succeeded: calls.filter((e) => e.data["outcome"] === "success").length,
    failProtocol: calls.filter((e) => e.data["outcome"] === "fail-protocol").length,
    judgmentsProposed: proposed.length,
    judgmentsKept: count(["confirmed", "waived", "fixed", "verified", "regressed"]),
    judgmentsDismissed: count(["dismissed"]),
  };
}
