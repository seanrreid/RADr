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

it("src/llm may not import decision modules or append decision events (M4 AC6)", async () => {
  const eslint = new ESLint({ cwd: repoRoot, ignore: false });
  const text = [
    'import { checkTransition } from "../findings/disposition.js";',
    'import type { Rubric } from "../rubric/rubric.js";',
    'import type { EventLog } from "../state/events.js";',
    "export function bad(log: EventLog, r: Rubric | null): void {",
    '  log.append("finding-disposition", "llm", { finding_id: "F-0001", from: "pending", to: "confirmed" });',
    '  log.append("llm-call", "llm", {});',
    "  void checkTransition; void r;",
    "}",
    "",
  ].join("\n");
  const [result] = await eslint.lintText(text, { filePath: path.join(repoRoot, "src/llm/policy.ts") });
  assert.ok(result);
  const hits = result.messages.map((m) => [m.ruleId, m.line]);
  assert.deepEqual(hits.filter(([r]) => r === "@typescript-eslint/no-restricted-imports"), [["@typescript-eslint/no-restricted-imports", 1]], "a value import is banned; type imports are not");
  assert.deepEqual(hits.filter(([r]) => r === "no-restricted-syntax"), [["no-restricted-syntax", 5]], "decision events are banned; llm-call is not");
});
