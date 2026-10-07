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
import { checkovAdapter, csvFields, hadolintAdapter, jscpdAdapter, lizardAdapter, sbomLicenseAdapter, scancodeAdapter, scorecardAdapter } from "../../src/normalize/health-adapters.js";
import { loadRubric } from "../../src/rubric/rubric.js";
import { FILES } from "../helpers/fixture-repo.js";

const golden = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../test/golden");
const read = (tool: string, file = "input.json") => readFileSync(path.join(golden, tool, file), "utf8");
const snippet: SnippetReader = (file, start, end) => {
  const text = FILES[file];
  return text === undefined ? null : text.split("\n").slice(start - 1, end).join("\n");
};
const common = { repoRoot: "/REPO", toolVersion: "pinned", snippet };

const classify = loadRubric("v1").classifyLicense;
if (classify === undefined) throw new Error("rubric v1 has no license classifier");
const policy = { classify, clientLicenses: [] as string[] };

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
  // M3 health lanes (captured from the pinned versions in the toolchain image / host install).
  it("lizard", () => { check("lizard", lizardAdapter({ ...common, raw: read("lizard", "input.csv"), rawRef: "raw/lizard.csv" })); });
  it("jscpd", () => { check("jscpd", jscpdAdapter({ ...common, raw: read("jscpd"), rawRef: "raw/jscpd.json" })); });
  it("checkov", () => { check("checkov", checkovAdapter({ ...common, raw: read("checkov"), rawRef: "raw/checkov.json" })); });
  it("hadolint", () => { check("hadolint", hadolintAdapter({ ...common, raw: read("hadolint"), rawRef: "raw/hadolint.json" })); });
  it("scancode", () => { check("scancode", scancodeAdapter({ ...common, raw: read("scancode"), rawRef: "raw/scancode.json" }, policy)); });
  it("sbom licenses", () => { check("sbom", sbomLicenseAdapter({ ...common, raw: read("sbom"), rawRef: "artifacts/sbom.json" }, policy)); });
  it("scorecard", () => { check("scorecard", scorecardAdapter({ ...common, raw: read("scorecard"), rawRef: "raw/scorecard.json" })); });
});

describe("health adapters: edge cases", () => {
  const r = (raw: string) => ({ ...common, raw, rawRef: "raw/x.json" });
  it("checkov: a summary-only object (nothing scanned) and a single-framework object", () => {
    assert.deepEqual(checkovAdapter(r('{"passed":0,"failed":0,"skipped":0,"parsing_errors":0,"resource_count":0,"checkov_version":"3.3.26"}')), []);
    const one = '{"check_type":"dockerfile","results":{"failed_checks":[{"check_id":"CKV_DOCKER_2","check_name":"Ensure HEALTHCHECK","file_path":"/Dockerfile","file_line_range":[1,4],"resource":"/Dockerfile."}]}}';
    const [f] = checkovAdapter(r(one));
    assert.equal(f?.file, "Dockerfile");
    assert.equal(f.raw_ref, "raw/x.json#/results/failed_checks/0");
  });
  it("lizard CSV: quoted commas, escaped quotes, and malformed rows", () => {
    assert.deepEqual(csvFields('1,"a, b","say ""hi""",x'), ["1", "a, b", 'say "hi"', "x"]);
    assert.throws(() => lizardAdapter(r("1,2,3")), ParseError);
    assert.throws(() => lizardAdapter(r('x,2,3,4,5,"l","a.py","f","f()",1,2')), /NLOC/);
  });
  it("license: the client's own license and permissive licenses are not flagged; unknown ids are", () => {
    const sc = (expr: string) => `{"files":[{"path":"a.c","type":"file","detected_license_expression_spdx":"${expr}","license_detections":[]}]}`;
    assert.equal(scancodeAdapter(r(sc("MIT")), policy).findings.length, 0);
    assert.equal(scancodeAdapter(r(sc("GPL-3.0-only")), { ...policy, clientLicenses: ["GPL-3.0-only"] }).findings.length, 0);
    assert.equal(scancodeAdapter(r(sc("LicenseRef-scancode-weird")), policy).findings[0]?.tool_severity, "unknown");
  });
  it("scorecard: scores outside -1..10 are refused; -1 (not applicable) is not a finding", () => {
    assert.throws(() => scorecardAdapter(r('{"checks":[{"name":"License","score":11,"reason":"x"}]}')), ParseError);
    assert.deepEqual(scorecardAdapter(r('{"checks":[{"name":"License","score":-1,"reason":"x"}]}')).findings, []);
  });
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
