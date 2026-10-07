// Deliberate determinism violations. Excluded from `npm run lint`; linted by
// test/unit/lint-guardrails.test.ts, which asserts each line below is flagged.
import { createHash } from "node:crypto";

export const a = ["b", "a"].sort((x, y) => x.localeCompare(y));
export const b = new Intl.Collator("de").compare("a", "b");
export const c = createHash("sha256").update("x").digest("hex");
export const d = JSON.stringify({ z: 1, a: 2 });
export const e = Date.now();
export const f = new Date();
