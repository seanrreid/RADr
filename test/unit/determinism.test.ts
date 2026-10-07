import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  DeterminismError,
  canonicalJson,
  compareCodePoints,
  hash,
  normalizePath,
  normalizeSnippet,
  stableSort,
} from "../../src/core/determinism.js";

// Arbitrary hashable values: integers, strings (full Unicode), booleans, null, nested.
const canonical = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: "small" },
    fc.constant(null),
    fc.boolean(),
    fc.maxSafeInteger(),
    fc.string({ unit: "grapheme" }),
    fc.array(tie("value"), { maxLength: 5 }),
    fc.dictionary(fc.string({ unit: "grapheme" }), tie("value"), { maxKeys: 5 }),
  ),
})).value;

/** Rebuild every object with its keys inserted in a shuffled order. */
function shuffleKeys(v: unknown, seed: number): unknown {
  if (Array.isArray(v)) return v.map((x) => shuffleKeys(x, seed + 1));
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v);
    const rotated = entries.slice(seed % (entries.length || 1)).concat(entries.slice(0, seed % (entries.length || 1))).reverse();
    return Object.fromEntries(rotated.map(([k, x]) => [k, shuffleKeys(x, seed + 1)]));
  }
  return v;
}

describe("canonicalJson / hash", () => {
  it("is invariant to object key insertion order", () => {
    fc.assert(
      fc.property(canonical, fc.nat(), (v, seed) => {
        assert.equal(canonicalJson(shuffleKeys(v, seed)), canonicalJson(v));
        assert.equal(hash(shuffleKeys(v, seed)), hash(v));
      }),
    );
  });

  it("is a fixed point: re-serializing its own parsed output is unchanged", () => {
    fc.assert(
      fc.property(canonical, (v) => {
        const s = canonicalJson(v);
        assert.equal(canonicalJson(JSON.parse(s)), s);
      }),
    );
  });

  it("sorts keys by code point, not UTF-16 code unit", () => {
    // U+FF61 (BMP, high) vs U+1F600 (astral): code-unit order puts the emoji first; code-point order does not.
    assert.equal(canonicalJson({ "😀": 1, "｡": 2 }), '{"｡":2,"😀":1}');
  });

  it("rejects non-hashable values instead of coercing them", () => {
    const sparse: unknown[] = [];
    sparse[0] = 1;
    sparse[2] = 3; // index 1 is a hole
    const bad: unknown[] = [undefined, NaN, Infinity, -Infinity, 1.5, 2 ** 53, 10n, () => 0, Symbol("s"),
      new Date(0), new Map(), { a: undefined }, sparse, { [Symbol("k")]: 1 }];
    for (const v of bad) assert.throws(() => canonicalJson(v), DeterminismError, `should reject ${String(v)}`);
  });

  it("treats -0 as 0", () => {
    assert.equal(canonicalJson(-0), "0");
  });

  it("produces sha256-prefixed hex", () => {
    assert.match(hash({ a: 1 }), /^sha256:[0-9a-f]{64}$/);
  });
});

describe("compareCodePoints / stableSort", () => {
  it("is a total order consistent with code points", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), fc.string({ unit: "binary" }), (a, b) => {
        const cp = (s: string) => Array.from(s, (c) => c.codePointAt(0) ?? 0);
        const [x, y] = [cp(a), cp(b)];
        let expected = 0;
        for (let i = 0; i < Math.min(x.length, y.length) && expected === 0; i++) expected = Math.sign((x[i] ?? 0) - (y[i] ?? 0));
        if (expected === 0) expected = Math.sign(x.length - y.length);
        assert.equal(Math.sign(compareCodePoints(a, b)), expected);
      }),
    );
  });

  it("gives the same order for any input permutation", () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.string({ unit: "grapheme" })), fc.nat(), (xs, seed) => {
        const rotated = xs.slice(seed % (xs.length || 1)).concat(xs.slice(0, seed % (xs.length || 1))).reverse();
        assert.deepEqual(stableSort(rotated, (s) => s), stableSort(xs, (s) => s));
      }),
    );
  });

  it("is stable for equal keys and supports tuple keys", () => {
    const items = [{ k: "b", n: 2, id: 1 }, { k: "a", n: 2, id: 2 }, { k: "a", n: 1, id: 3 }, { k: "a", n: 2, id: 4 }];
    assert.deepEqual(stableSort(items, (i) => [i.k, i.n]).map((i) => i.id), [3, 2, 4, 1]);
  });

  it("rejects mixed or float keys", () => {
    assert.throws(() => stableSort([1, "a"] as (string | number)[], (x) => x), DeterminismError);
    assert.throws(() => stableSort([1.5, 2], (x) => x), DeterminismError);
  });
});

describe("normalizeSnippet", () => {
  it("is invariant to CRLF/LF, trailing whitespace, indentation, and NFC/NFD", () => {
    const lf = "if (x) {\n  run(\"café\");\n}\n";
    const crlf = "\r\n\tif (x) {   \r\n        run(\"café\");\r\n}\r\n\r\n";
    assert.equal(normalizeSnippet(crlf), normalizeSnippet(lf));
  });

  it("is idempotent", () => {
    fc.assert(fc.property(fc.string({ unit: "grapheme" }), (s) => {
      assert.equal(normalizeSnippet(normalizeSnippet(s)), normalizeSnippet(s));
    }));
  });
});

describe("normalizePath", () => {
  const root = "/work/repo";
  it("produces repo-relative POSIX paths", () => {
    assert.equal(normalizePath("./src//a.ts", root), "src/a.ts");
    assert.equal(normalizePath("src\\win\\b.ts", root), "src/win/b.ts");
    assert.equal(normalizePath("/work/repo/src/c.ts", root), "src/c.ts");
    assert.equal(normalizePath("src/x/../d.ts", root + "/"), "src/d.ts");
  });
  it("rejects paths outside the root, and the root itself", () => {
    assert.throws(() => normalizePath("../etc/passwd", root), DeterminismError);
    assert.throws(() => normalizePath("/work/repo-evil/a.ts", root), DeterminismError);
    assert.throws(() => normalizePath("/etc/passwd", root), DeterminismError);
    assert.throws(() => normalizePath(".", root), DeterminismError);
  });
});
