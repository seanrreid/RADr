// The one prompt format: radr's own fixed instructions, then a canonical-JSON data block.
// Keeping client-derived content inside the data block (and nowhere else) lets the invariant-3
// eval check exactly the fields that could carry client bytes.

import { canonicalJson } from "../core/determinism.js";
import { InternalError } from "../core/errors.js";
import type { PromptFinding } from "./redact.js";

export const DEFAULT_MAX_PROMPT_BYTES = 200_000;
const OPEN = "<data>\n";
const CLOSE = "\n</data>\n";

/**
 * Data fields that are metadata by definition (PRD §9: rule IDs, paths, metrics). Every other
 * string in the data block is free text and is checked by the invariant-3 eval.
 */
export const METADATA_KEYS: ReadonlySet<string> = new Set(["purpose", "id", "lane", "tool", "rule_id", "category", "severity", "file", "cve", "cvss"]);

export interface PromptData {
  readonly purpose: string;
  /** Purpose-specific, canonical-JSON-safe context (engagement type, metrics, …). */
  readonly context: Readonly<Record<string, unknown>>;
  readonly findings: readonly PromptFinding[];
}

export function renderPrompt(instructions: string, data: PromptData): string {
  return `${instructions.trimEnd()}\n\n${OPEN}${canonicalJson(data)}${CLOSE}`;
}

/**
 * Split findings into prompts no larger than maxBytes, in the given order. A single finding that
 * alone exceeds the cap is an error: snippets are bounded, so that means the cap is too small.
 */
export function batchPrompts(instructions: string, purpose: string, context: PromptData["context"], findings: readonly PromptFinding[], maxBytes = DEFAULT_MAX_PROMPT_BYTES): { prompt: string; ids: string[] }[] {
  const out: { prompt: string; ids: string[] }[] = [];
  let batch: PromptFinding[] = [];
  const render = (b: readonly PromptFinding[]) => renderPrompt(instructions, { purpose, context, findings: b });
  for (const f of findings) {
    if (batch.length > 0 && Buffer.byteLength(render([...batch, f])) > maxBytes) {
      out.push({ prompt: render(batch), ids: batch.map((x) => x.id) });
      batch = [];
    }
    if (Buffer.byteLength(render([f])) > maxBytes) throw new InternalError(`finding ${f.id} alone exceeds the ${String(maxBytes)}-byte prompt cap`);
    batch.push(f);
  }
  if (batch.length > 0 || out.length === 0) out.push({ prompt: render(batch), ids: batch.map((x) => x.id) });
  return out;
}

/** The free text of a prompt's data block: every string value whose key isn't metadata. */
export function promptFreeText(prompt: string): string {
  const start = prompt.indexOf(OPEN);
  const end = prompt.lastIndexOf(CLOSE);
  if (start === -1 || end < start) throw new InternalError("prompt has no data block");
  const data: unknown = JSON.parse(prompt.slice(start + OPEN.length, end));
  const parts: string[] = [];
  const walk = (v: unknown, key: string): void => {
    if (typeof v === "string") {
      if (!METADATA_KEYS.has(key)) parts.push(v);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, key);
    } else if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, k);
    }
  };
  walk(data, "");
  return parts.join("\n");
}
