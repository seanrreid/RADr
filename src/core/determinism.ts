// The single source of serialization, ordering, and hashing (PRD §15).
// Lint forbids JSON.stringify, createHash, localeCompare, and Intl outside this file,
// so every fingerprint in radr is computed here and nowhere else.

import { createHash } from "node:crypto";
import path from "node:path";

export class DeterminismError extends Error {
  override readonly name = "DeterminismError";
}

/** JSON values radr is willing to hash: no floats, no undefined, plain objects only. */
export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

const HASH_PREFIX = "sha256:";

/** Total order over strings by Unicode code point (not UTF-16 code unit, not locale). */
export function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const ca = ia.next();
    const cb = ib.next();
    if (ca.done === true) return cb.done === true ? 0 : -1;
    if (cb.done === true) return 1;
    const pa = ca.value.codePointAt(0) ?? 0;
    const pb = cb.value.codePointAt(0) ?? 0;
    if (pa !== pb) return pa < pb ? -1 : 1;
  }
}

/**
 * Serialize to JSON with recursively sorted keys. Throws (never coerces) on anything that
 * could serialize differently across runs or platforms.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, "$");
}

function serialize(value: unknown, at: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new DeterminismError(`${at}: only safe integers are hashable (got ${String(value)}); store scores as strings or scaled integers`);
      }
      return Object.is(value, -0) ? "0" : String(value);
    case "object":
      return Array.isArray(value) ? serializeArray(value, at) : serializeObject(value, at);
    default:
      throw new DeterminismError(`${at}: ${typeof value} is not hashable`);
  }
}

function serializeArray(items: readonly unknown[], at: string): string {
  const parts: string[] = [];
  for (let i = 0; i < items.length; i++) {
    if (!(i in items)) throw new DeterminismError(`${at}[${i}]: sparse arrays are not hashable`);
    parts.push(serialize(items[i], `${at}[${i}]`));
  }
  return `[${parts.join(",")}]`;
}

function serializeObject(obj: object, at: string): string {
  const proto: unknown = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) {
    throw new DeterminismError(`${at}: only plain objects are hashable (got ${obj.constructor.name})`);
  }
  if (Object.getOwnPropertySymbols(obj).length > 0) {
    throw new DeterminismError(`${at}: symbol keys are not hashable`);
  }
  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareCodePoints);
  const parts = keys.map((key) => {
    const v = record[key];
    if (v === undefined) throw new DeterminismError(`${at}.${key}: undefined is not hashable (omit the key instead)`);
    return `${JSON.stringify(key)}:${serialize(v, `${at}.${key}`)}`;
  });
  return `{${parts.join(",")}}`;
}

/** The only way radr fingerprints a value: sha256 over its canonical JSON. */
export function hash(value: unknown): string {
  return hashBytes(canonicalJson(value));
}

/** Hash raw bytes (tool output, files). Strings are hashed as UTF-8. */
export function hashBytes(data: string | Uint8Array): string {
  return HASH_PREFIX + createHash("sha256").update(data).digest("hex");
}

export type SortKey = string | number | readonly (string | number)[];

function compareKeys(a: SortKey, b: SortKey): number {
  const ta = Array.isArray(a) ? a : [a];
  const tb = Array.isArray(b) ? b : [b];
  const n = Math.min(ta.length, tb.length);
  for (let i = 0; i < n; i++) {
    const c = compareScalar(ta[i] as string | number, tb[i] as string | number);
    if (c !== 0) return c;
  }
  return ta.length - tb.length;
}

function compareScalar(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") {
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) {
      throw new DeterminismError("sort keys must be safe integers or strings");
    }
    return a === b ? 0 : a < b ? -1 : 1;
  }
  if (typeof a === "string" && typeof b === "string") return compareCodePoints(a, b);
  throw new DeterminismError(`sort key type mismatch: ${typeof a} vs ${typeof b}`);
}

/** Returns a new array ordered by `key` (code-point / integer order). Stable for equal keys. */
export function stableSort<T>(items: readonly T[], key: (item: T) => SortKey): T[] {
  return items
    .map((item, index) => ({ item, index, k: key(item) }))
    .sort((x, y) => compareKeys(x.k, y.k) || x.index - y.index)
    .map((e) => e.item);
}

/**
 * Normalize a file path to repo-relative POSIX form. Pure string operation: callers that need
 * symlink resolution must realpath both arguments first. Throws if the path escapes the root.
 */
export function normalizePath(p: string, repoRoot: string): string {
  const toPosix = (s: string): string => s.replace(/\\/g, "/");
  const root = path.posix.resolve("/", toPosix(repoRoot));
  const raw = toPosix(p);
  const abs = path.posix.isAbsolute(raw) ? path.posix.normalize(raw) : path.posix.resolve(root, raw);
  const rel = path.posix.relative(root, abs);
  if (rel === "") throw new DeterminismError(`path ${p} is the repo root, not a file`);
  if (rel === ".." || rel.startsWith("../") || path.posix.isAbsolute(rel)) {
    throw new DeterminismError(`path ${p} escapes repo root ${repoRoot}`);
  }
  return rel;
}

/**
 * Normalize a code snippet for hashing so cosmetic drift (line endings, indentation,
 * trailing whitespace, Unicode composition) doesn't change a finding's fingerprint.
 */
export function normalizeSnippet(s: string): string {
  const lines = s
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/[ \t]+/g, " "));
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}
