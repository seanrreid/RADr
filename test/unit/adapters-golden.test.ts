// Golden tests (T5.1, AC13): real tool output captured from the pinned versions (paths scrubbed
// to /REPO) must normalize to byte-identical drafts. Regenerate deliberately with
//   UPDATE_GOLDEN=1 npm test
// and review the diff: a golden change is a behavior change.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../../src/core/determinism.js";
import { ParseError, eslintAdapter, gitleaksAdapter, opengrepAdapter, osvAdapter, ruffAdapter, sccMetrics, type SnippetReader } from "../../src/normalize/adapters.js";
import { FILES } from "../helpers/fixture-repo.js";

const golden = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../test/golden");
const read = (tool: string) => readFileSync(path.join(golden, tool, "input.json"), "utf8");
const snippet: SnippetReader = (file, start, end) => {
  const text = FILES[file];
  return text === undefined ? null : text.split("\n").slice(start - 1, end).join("\n");
};
const common = { repoRoot: "/REPO", toolVersion: "pinned", snippet };

function check(tool: string, actual: unknown): void {
  const expectedFile = path.join(golden, tool, "expected.jsonl");
  const lines = (Array.isArray(actual) ? actual : [actual]).map((x) => canonicalJson(x)).join("\n") + "\n";
  if (process.env["UPDATE_GOLDEN"] === "1" || !existsSync(expectedFile)) writeFileSync(expectedFile, lines);
  assert.equal(lines, readFileSync(expectedFile, "utf8"), `${tool} golden output changed`);
}

describe("adapter golden outputs (pinned tool versions)", () => {
  it("eslint", () => { check("eslint", eslintAdapter({ ...common, raw: read("eslint"), rawRef: "raw/eslint.json" })); });
  it("ruff", () => { check("ruff", ruffAdapter({ ...common, raw: read("ruff"), rawRef: "raw/ruff.json" })); });
  it("gitleaks", () => {
    check("gitleaks", gitleaksAdapter({ ...common, raw: read("gitleaks"), rawRef: "raw/gitleaks.json", presentAtHead: (f) => f in FILES }));
  });
  it("osv-scanner", () => { check("osv-scanner", osvAdapter({ ...common, raw: read("osv-scanner"), rawRef: "raw/osv.json" })); });
  it("scc", () => { check("scc", sccMetrics(read("scc"))); });
  it("opengrep", () => { check("opengrep", opengrepAdapter({ ...common, raw: read("opengrep"), rawRef: "raw/opengrep.json" })); });
});

describe("adapters refuse output they don't understand", () => {
  const r = (raw: string) => ({ ...common, raw, rawRef: "raw/x.json" });
  it("non-JSON, wrong shapes, and floats where integers belong", () => {
    assert.throws(() => eslintAdapter(r("not json")), ParseError);
    assert.throws(() => ruffAdapter(r("{}")), ParseError);
    assert.throws(() => eslintAdapter(r('[{"filePath":"/REPO/a.js","messages":[{"ruleId":"x","severity":2,"line":1.5,"message":"m"}]}]')), ParseError);
  });
  it("paths outside the repo root", () => {
    assert.throws(() => ruffAdapter(r('[{"filename":"/etc/passwd","code":"F401","message":"m","location":{"row":1}}]')), ParseError);
  });
  it("an unredacted secret (refuses to persist it)", () => {
    const leak = '[{"RuleID":"x","Description":"d","StartLine":1,"EndLine":1,"Secret":"hunter2","File":"a","Commit":"c","Fingerprint":"f"}]';
    assert.throws(() => gitleaksAdapter({ ...r(leak), presentAtHead: () => true }), /not redacted/);
  });
  it("a malformed CVSS score", () => {
    const bad = '{"results":[{"source":{"path":"/REPO/package-lock.json"},"packages":[{"package":{"ecosystem":"npm","name":"x","version":"1"},"vulnerabilities":[{"id":"GHSA-1"}],"groups":[{"ids":["GHSA-1"],"max_severity":"high"}]}]}]}';
    assert.throws(() => osvAdapter(r(bad)), /max_severity/);
  });
});
