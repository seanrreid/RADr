import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fixedClock } from "../../src/core/clock.js";
import { hash } from "../../src/core/determinism.js";
import { InternalError, UsageError } from "../../src/core/errors.js";
import { parseYaml } from "../../src/core/yaml.js";
import { Matrix, runStatus } from "../../src/matrix/matrix.js";
import { EventLog } from "../../src/state/events.js";
import { Gates } from "../../src/state/gates.js";
import { tmpDir } from "../helpers/tmp.js";

describe("Matrix (policy/matrix.yml)", () => {
  const m = Matrix.load();

  it("has an entry for every (lane, outcome) pair (AC6)", () => {
    assert.deepEqual(m.lanes, ["census", "lint", "secrets", "sca", "history", "tests", "types", "coverage", "sast", "maint", "license", "iac", "hygiene"]);
    for (const lane of m.lanes) for (const outcome of m.outcomes) assert.doesNotThrow(() => m.resolve(lane, outcome, 1));
  });

  it("throws on unknown lanes and outcomes (no fallthrough)", () => {
    assert.throws(() => m.resolve("nope", "success", 1), InternalError);
    assert.throws(() => m.resolve("lint", "made-up", 1), InternalError);
    assert.throws(() => m.resolve("lint", "__proto__", 1), InternalError);
  });

  it("fails closed on a missing tool or version drift", () => {
    assert.equal(m.resolve("secrets", "tool-missing", 1).action, "abort");
    assert.equal(m.resolve("sca", "version-drift", 1).action, "abort");
  });

  it("retries tool errors up to max_attempts, then applies `then`", () => {
    assert.deepEqual(m.resolve("lint", "tool-error", 1), { action: "retry", nextAttempt: 2 });
    assert.deepEqual(m.resolve("lint", "tool-error", 2), { action: "partial" });
  });

  it("rejects a table with a missing cell", () => {
    const yaml = "version: 1\noutcomes: [success, timeout]\nactions: [continue, partial]\ntable:\n  lint:\n    success: { action: continue }\n";
    assert.throws(() => Matrix.fromYaml(yaml, "t.yml"), /no entry for outcome "timeout"/);
  });

  it("rejects a cell for an undeclared outcome", () => {
    const yaml = "version: 1\noutcomes: [success]\nactions: [continue]\ntable:\n  lint:\n    success: { action: continue }\n    extra: { action: abort }\n";
    assert.throws(() => Matrix.fromYaml(yaml, "t.yml"), /undeclared outcome "extra"/);
  });

  it("rejects a retry cell without max_attempts/then", () => {
    const yaml = "version: 1\noutcomes: [success]\nactions: [retry]\ntable:\n  lint:\n    success: { action: retry }\n";
    assert.throws(() => Matrix.fromYaml(yaml, "t.yml"), InternalError);
  });

  it("derives run status from lane actions", () => {
    assert.equal(runStatus(["continue", "continue"]), "complete");
    assert.equal(runStatus(["continue", "partial"]), "partial");
    assert.equal(runStatus(["partial", "abort"]), "aborted");
  });
});

describe("Gates (policy/gates.yml)", () => {
  const gates = Gates.load();
  const fpA = hash("scope-a");
  const fpB = hash("scope-b");
  const sha = "a".repeat(40);
  const newLog = () => new EventLog(path.join(tmpDir(), "events.jsonl"), fixedClock("2026-10-07T00:00:00Z", 1000));

  it("is closed with no approval", () => {
    const r = gates.evaluate("scope", [], { fingerprint: fpA });
    assert.equal(r.passed, false);
    assert.match(r.reason, /radr approve scope/);
  });

  it("opens when the latest approval matches the current fingerprint", () => {
    const log = newLog();
    log.append("scope-approved", "sean", { fingerprint: fpA, sha });
    assert.equal(gates.evaluate("scope", log.read(), { fingerprint: fpA }).passed, true);
  });

  it("closes when the scope has changed since approval", () => {
    const log = newLog();
    log.append("scope-approved", "sean", { fingerprint: fpA, sha });
    const r = gates.evaluate("scope", log.read(), { fingerprint: fpB });
    assert.equal(r.passed, false);
    assert.match(r.reason, /scope changed since approval/);
  });

  it("uses the latest approval (re-approval after a change reopens it)", () => {
    const log = newLog();
    log.append("scope-approved", "sean", { fingerprint: fpA, sha });
    log.append("scope-approved", "sean", { fingerprint: fpB, sha });
    assert.equal(gates.evaluate("scope", log.read(), { fingerprint: fpB }).passed, true);
    assert.equal(gates.evaluate("scope", log.read(), { fingerprint: fpA }).passed, false);
  });

  it("throws on an unknown gate", () => {
    assert.throws(() => gates.evaluate("nope", [], { fingerprint: fpA }), InternalError);
  });
});

describe("parseYaml", () => {
  it("rejects duplicate keys", () => {
    assert.throws(() => parseYaml("a: 1\na: 2\n", "t.yml"), UsageError);
  });
  it("rejects aliases", () => {
    assert.throws(() => parseYaml("x: &a { k: 1 }\ny: *a\n", "t.yml"), UsageError);
  });
  it("parses plain YAML 1.2 (no yes/no booleans)", () => {
    assert.deepEqual(parseYaml("a: yes\nb: true\n", "t.yml"), { a: "yes", b: true });
  });
});
