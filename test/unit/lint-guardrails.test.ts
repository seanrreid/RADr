import { it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixture = path.join(repoRoot, "test/fixtures/lint/violations.ts");

it("the real ESLint config flags every determinism violation (AC4)", async () => {
  const eslint = new ESLint({ cwd: repoRoot, ignore: false });
  const [result] = await eslint.lintFiles([fixture]);
  assert.ok(result, "fixture was not linted");
  const flaggedLines = new Set(
    result.messages.filter((m) => m.ruleId === "no-restricted-syntax").map((m) => m.line),
  );
  // Lines 5–10 of the fixture each contain one banned construct.
  for (const line of [5, 6, 7, 8, 9, 10]) {
    assert.ok(flaggedLines.has(line), `line ${line} was not flagged; flagged: ${[...flaggedLines].join(",")}`);
  }
});
