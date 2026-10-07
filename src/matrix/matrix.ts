// Loads policy/matrix.yml and resolves (lane, outcome, attempt) → action (M1 AC6).
// No defaults: an unknown lane or outcome, or a table with a missing cell, throws.

import { readAsset } from "../core/assets.js";
import { InternalError } from "../core/errors.js";
import { parseYaml } from "../core/yaml.js";
import { SLUG, makeValidator } from "../schemas/validate.js";

export type Action = "continue" | "retry" | "partial" | "abort";
type Terminal = Exclude<Action, "retry">;

interface Cell {
  readonly action: Action;
  readonly max_attempts?: number;
  readonly then?: Terminal;
}

export interface MatrixDoc {
  readonly version: 1;
  readonly outcomes: readonly string[];
  readonly actions: readonly Action[];
  readonly table: Readonly<Record<string, Readonly<Record<string, Cell>>>>;
}

const terminal = { enum: ["continue", "partial", "abort"] };
const cellSchema = {
  oneOf: [
    { type: "object", additionalProperties: false, required: ["action"], properties: { action: terminal } },
    {
      type: "object",
      additionalProperties: false,
      required: ["action", "max_attempts", "then"],
      properties: { action: { const: "retry" }, max_attempts: { type: "integer", minimum: 2, maximum: 5 }, then: terminal },
    },
  ],
};

const validateDoc = makeValidator<MatrixDoc>(
  {
    type: "object",
    additionalProperties: false,
    required: ["version", "outcomes", "actions", "table"],
    properties: {
      version: { const: 1 },
      outcomes: { type: "array", items: { type: "string", pattern: SLUG }, uniqueItems: true, minItems: 1 },
      actions: { type: "array", items: { enum: ["continue", "retry", "partial", "abort"] }, uniqueItems: true },
      table: {
        type: "object",
        propertyNames: { pattern: SLUG },
        additionalProperties: { type: "object", additionalProperties: cellSchema },
      },
    },
  },
  InternalError,
);

export interface Resolution {
  readonly action: Terminal | "retry";
  /** For `retry`: the attempt number to run next. */
  readonly nextAttempt?: number;
}

export class Matrix {
  private constructor(private readonly doc: MatrixDoc) {}

  static fromYaml(text: string, source: string): Matrix {
    const doc = validateDoc(parseYaml(text, source), source);
    for (const [lane, row] of Object.entries(doc.table)) {
      for (const outcome of doc.outcomes) {
        if (!Object.hasOwn(row, outcome)) throw new InternalError(`${source}: lane "${lane}" has no entry for outcome "${outcome}"`);
      }
      for (const outcome of Object.keys(row)) {
        if (!doc.outcomes.includes(outcome)) throw new InternalError(`${source}: lane "${lane}" declares undeclared outcome "${outcome}"`);
      }
    }
    return new Matrix(doc);
  }

  static load(): Matrix {
    return Matrix.fromYaml(readAsset("policy/matrix.yml"), "policy/matrix.yml");
  }

  get lanes(): string[] {
    return Object.keys(this.doc.table);
  }

  get outcomes(): readonly string[] {
    return this.doc.outcomes;
  }

  resolve(lane: string, outcome: string, attempt: number): Resolution {
    const row = this.doc.table[lane];
    if (row === undefined) throw new InternalError(`matrix: unknown lane "${lane}"`);
    const cell = Object.hasOwn(row, outcome) ? row[outcome] : undefined;
    if (cell === undefined) throw new InternalError(`matrix: no entry for (${lane}, ${outcome})`);
    if (cell.action !== "retry") return { action: cell.action };
    const max = cell.max_attempts ?? 0;
    if (attempt < max) return { action: "retry", nextAttempt: attempt + 1 };
    if (cell.then === undefined) throw new InternalError(`matrix: retry cell (${lane}, ${outcome}) lacks "then"`);
    return { action: cell.then };
  }
}

/** Run status from per-lane terminal actions: any abort → aborted; any partial → partial. */
export function runStatus(actions: readonly Terminal[]): "complete" | "partial" | "aborted" {
  if (actions.includes("abort")) return "aborted";
  if (actions.includes("partial")) return "partial";
  return "complete";
}
