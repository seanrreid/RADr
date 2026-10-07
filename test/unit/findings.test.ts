import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RefusedError } from "../../src/core/errors.js";
import { globToRegExp, inScope } from "../../src/core/glob.js";
import type { EngagementDoc } from "../../src/engagement/config.js";
import { checkTransition } from "../../src/findings/disposition.js";
import { fingerprintDrafts, findingsSetHash, ingest, latestRunFindings, readStore } from "../../src/findings/store.js";
import type { FindingDraft } from "../../src/findings/types.js";
import { cvssTenths, loadRubric } from "../../src/rubric/rubric.js";
import { tmpDir } from "../helpers/tmp.js";

const draft = (over: Partial<FindingDraft> = {}): FindingDraft => ({
  lane: "lint", tool: "ruff", tool_version: "0.16.10", rule_id: "F401", category: "quality", file: "app/main.py",
  line: 1, end_line: 1, message: "`os` imported but unused", tool_severity: "error", snippet: "import os",
  engine_fingerprint: null, cve: null, aliases: [], cvss: null, raw_ref: "raw/R-0001/lint.attempt-1/ruff.json#/0", tags: [],
  ...over,
});

const doc = { paths: { include: ["**"], exclude: ["vendor/**", "**/*.min.js"] } } as unknown as EngagementDoc;

describe("glob", () => {
  it("matches ** across directories, * within a segment", () => {
    assert.ok(globToRegExp("**").test("a/b/c.ts"));
    assert.ok(globToRegExp("src/**/*.ts").test("src/a.ts"));
    assert.ok(globToRegExp("src/**/*.ts").test("src/x/y/a.ts"));
    assert.ok(!globToRegExp("src/*.ts").test("src/x/a.ts"));
    assert.ok(!globToRegExp("*.py").test("app/main.py"));
    assert.ok(globToRegExp("a.b?").test("a.bc") && !globToRegExp("a.b?").test("axbc"));
  });
  it("include minus exclude", () => {
    assert.equal(inScope("src/a.js", doc.paths), true);
    assert.equal(inScope("vendor/lib/a.js", doc.paths), false);
    assert.equal(inScope("public/app.min.js", doc.paths), false);
  });
});

describe("rubric v0 (AC14)", () => {
  const rubric = loadRubric("v0");
  it("maps every M1 tool severity and CVSS bands", () => {
    assert.equal(rubric.severityOf(draft()), "low");
    assert.equal(rubric.severityOf(draft({ tool: "eslint", tool_severity: "1" })), "info");
    assert.equal(rubric.severityOf(draft({ tool: "gitleaks", tool_severity: "secret" })), "high");
    for (const [cvss, sev] of [["9.8", "critical"], ["7.0", "high"], ["6.9", "medium"], ["4.0", "medium"], ["3.9", "low"], ["0.0", "info"], ["10.0", "critical"]] as const) {
      assert.equal(rubric.severityOf(draft({ tool: "osv-scanner", tool_severity: "cvss", cvss })), sev, cvss);
    }
    assert.equal(rubric.severityOf(draft({ tool: "osv-scanner", tool_severity: "unscored" })), "medium");
  });
  it("refuses unmapped pairs instead of defaulting", () => {
    assert.throws(() => rubric.severityOf(draft({ tool_severity: "warning" })), /no mapping for \(ruff, warning\)/);
    assert.throws(() => rubric.severityOf(draft({ tool: "mystery" })), RefusedError);
  });
  it("parses CVSS strictly into tenths", () => {
    assert.equal(cvssTenths("7.2"), 72);
    assert.equal(cvssTenths("10"), 100);
    for (const bad of ["7.25", "-1", "11.0", "high", ""]) assert.throws(() => cvssTenths(bad), RefusedError, bad);
  });
  it("rejects rubric versions that aren't available yet", () => {
    assert.throws(() => loadRubric("v1"), /M2/);
  });
});

describe("fingerprints (T5.2, AC13)", () => {
  it("are independent of input order", () => {
    const ds = [draft(), draft({ rule_id: "F841", line: 6, snippet: "unused = 42" }), draft({ tool: "eslint", file: "src/a.ts" })];
    const a = fingerprintDrafts(ds).map((x) => x.fingerprint);
    const b = fingerprintDrafts([...ds].reverse()).map((x) => x.fingerprint);
    assert.deepEqual([...a].sort(), [...b].sort());
  });
  it("survive code moving to another line (line numbers are not identity)", () => {
    const [moved] = fingerprintDrafts([draft({ line: 40, end_line: 40 })]);
    const [orig] = fingerprintDrafts([draft()]);
    assert.equal(moved?.fingerprint, orig?.fingerprint);
  });
  it("keep two identical occurrences as two findings", () => {
    const fps = fingerprintDrafts([draft({ line: 3 }), draft({ line: 9 })]).map((x) => x.fingerprint);
    assert.equal(new Set(fps).size, 2);
  });
  it("prefer the engine fingerprint when present", () => {
    const [a] = fingerprintDrafts([draft({ tool: "gitleaks", engine_fingerprint: "c1:f:r:2", snippet: null })]);
    const [b] = fingerprintDrafts([draft({ tool: "gitleaks", engine_fingerprint: "c1:f:r:2", snippet: null, file: "elsewhere", line: 99 })]);
    assert.equal(a?.fingerprint, b?.fingerprint);
  });
});

describe("findings store (T5.4)", () => {
  const rubric = loadRubric("v0");
  const fullDoc = doc;

  it("assigns stable ids, reuses them on re-runs, and records each run's set", () => {
    const file = path.join(tmpDir(), "findings.jsonl");
    const ds = [draft(), draft({ rule_id: "F841", line: 6, snippet: "unused = 42" })];
    const r1 = ingest(file, "R-0001", fullDoc, rubric, ds);
    assert.equal(r1.added, 2);
    const r2 = ingest(file, "R-0002", fullDoc, rubric, [...ds].reverse());
    assert.equal(r2.added, 0);
    assert.deepEqual(r2.present.map((f) => f.id).sort(), ["F-0001", "F-0002"]);
    assert.equal(r1.setHash, r2.setHash);
    const r3 = ingest(file, "R-0003", fullDoc, rubric, [ds[0] ?? draft(), draft({ rule_id: "E401" })]);
    assert.equal(r3.added, 1);
    assert.equal(r3.present.find((f) => f.rule_id === "E401")?.id, "F-0003");
    assert.equal(latestRunFindings(file).runId, "R-0003");
    assert.equal(readStore(file).runs.length, 3);
  });

  it("drops out-of-scope findings before they get ids", () => {
    const file = path.join(tmpDir(), "findings.jsonl");
    const r = ingest(file, "R-0001", fullDoc, rubric, [draft(), draft({ file: "vendor/x.py" })]);
    assert.equal(r.present.length, 1);
    assert.equal(r.outOfScope, 1);
  });

  it("set hash ignores raw_ref (it embeds the run id)", () => {
    const fa = path.join(tmpDir(), "a.jsonl");
    const fb = path.join(tmpDir(), "b.jsonl");
    const a = ingest(fa, "R-0001", fullDoc, rubric, [draft()]);
    const b = ingest(fb, "R-0001", fullDoc, rubric, [draft({ raw_ref: "raw/R-0009/elsewhere#/0" })]);
    assert.equal(findingsSetHash(a.present), findingsSetHash(b.present));
  });

  it("refuses a corrupted store", () => {
    const file = path.join(tmpDir(), "findings.jsonl");
    ingest(file, "R-0001", fullDoc, rubric, [draft()]);
    writeFileSync(file, readFileSync(file, "utf8").replace('"severity":"low"', '"severity": "low"'));
    assert.throws(() => readStore(file), /canonical/);
  });
});

describe("disposition transitions (AC15)", () => {
  it("allows only table transitions, with reasons where required", () => {
    assert.doesNotThrow(() => { checkTransition("pending", "confirmed", undefined); });
    assert.doesNotThrow(() => { checkTransition("pending", "dismissed", "false positive: test fixture"); });
    assert.throws(() => { checkTransition("pending", "dismissed", undefined); }, /requires --reason/);
    assert.throws(() => { checkTransition("pending", "waived", "  "); }, /requires --reason/);
    assert.throws(() => { checkTransition("dismissed", "confirmed", undefined); }, /illegal transition/);
    assert.throws(() => { checkTransition("pending", "fixed", undefined); }, /can't be set by hand/);
    assert.throws(() => { checkTransition("pending", "verified", undefined); }, RefusedError);
  });
});
