// M2 Wave 0: rubric v1 (AC1), EPSS/KEV snapshots (AC2), auto-confirm (AC3), bulk disposition (AC4).

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { fixedClock } from "../../src/core/clock.js";
import { RefusedError } from "../../src/core/errors.js";
import type { FindingDraft } from "../../src/findings/types.js";
import { NO_VULN_CONTEXT, autoConfirms, inReviewSet, loadRubric, type VulnContext } from "../../src/rubric/rubric.js";
import { decimalToBp, loadVulnContext, parseEpss, parseKev, syncContext, verifyContext } from "../../src/toolchain/vulnctx.js";
import { EventLog } from "../../src/state/events.js";
import { layout } from "../../src/engagement/home.js";
import { cliRunner } from "../helpers/cli.js";
import { seedHome, setFakeTool } from "../helpers/fake-toolchain.js";
import { makeFixtureRepo, type FixtureRepo } from "../helpers/fixture-repo.js";
import { tmpDir } from "../helpers/tmp.js";

const draft = (over: Partial<FindingDraft> = {}): FindingDraft => ({
  lane: "lint", tool: "ruff", tool_version: "x", rule_id: "F401", category: "quality", file: "app/main.py", line: 1, end_line: 1,
  message: "m", tool_severity: "error", snippet: null, engine_fingerprint: null, cve: null, aliases: [], cvss: null, raw_ref: "r", tags: [],
  ...over,
});
const vuln = (over: Partial<FindingDraft> = {}) => draft({ lane: "sca", tool: "osv-scanner", category: "dependency", tool_severity: "cvss", cvss: "7.2", cve: "CVE-2021-23337", file: "package-lock.json", ...over });
const ctx = (epss: number | null | undefined, kev: boolean | undefined): VulnContext => ({ epssBp: () => epss, kev: () => kev });

const EPSS_CSV = "#model_version:v2026.06.15,score_date:2026-10-07T12:00:27Z\ncve,epss,percentile\nCVE-2021-23337,0.21333,0.97548\nCVE-2018-18074,0.07443,0.94302\n";
const KEV_JSON = JSON.stringify({ catalogVersion: "2026.10.04", vulnerabilities: [{ cveID: "CVE-2024-0001" }] });

describe("rubric v1 severity pipeline (AC1)", () => {
  const r = loadRubric("v1");

  it("applies base mappings and rule overrides", () => {
    assert.equal(r.assess(draft(), NO_VULN_CONTEXT).severity, "low");
    assert.equal(r.assess(draft({ tool: "gitleaks", tool_severity: "secret", category: "secrets", rule_id: "aws-access-token", lane: "secrets" }), NO_VULN_CONTEXT).severity, "critical");
    assert.equal(r.assess(draft({ tool: "gitleaks", tool_severity: "secret", category: "secrets", rule_id: "generic-api-key", lane: "secrets" }), NO_VULN_CONTEXT).severity, "medium");
    assert.equal(r.assess(draft({ tool: "pyright", tool_severity: "information" }), NO_VULN_CONTEXT).severity, "info");
  });

  it("promotes on KEV (to critical) and EPSS at the 1000 bp boundary (+1)", () => {
    assert.deepEqual(r.assess(vuln(), ctx(999, false)), { severity: "high", epss_bp: 999, kev: false });
    assert.deepEqual(r.assess(vuln(), ctx(1000, false)), { severity: "critical", epss_bp: 1000, kev: false });
    assert.equal(r.assess(vuln({ cvss: "4.1" }), ctx(null, true)).severity, "critical");
    assert.equal(r.assess(vuln({ cvss: "9.8" }), ctx(9000, true)).severity, "critical", "clamped at critical");
  });

  it("records unknown context as null and never promotes on it (fail-open)", () => {
    assert.deepEqual(r.assess(vuln(), NO_VULN_CONTEXT), { severity: "high", epss_bp: null, kev: null });
    assert.deepEqual(r.assess(vuln(), ctx(null, false)), { severity: "high", epss_bp: null, kev: false });
  });

  it("demotes non-production paths one step (never secrets or dependencies) and promotes sensitive SAST paths", () => {
    assert.equal(r.assess(draft({ file: "tests/test_app.py" }), NO_VULN_CONTEXT).severity, "info");
    assert.equal(r.assess(draft({ file: "tests/test_app.py", tool_severity: "error", tool: "pyright" }), NO_VULN_CONTEXT).severity, "info");
    assert.equal(r.assess(draft({ file: "info.py", tool: "eslint", tool_severity: "1" }), NO_VULN_CONTEXT).severity, "info", "already the floor");
    assert.equal(r.assess(vuln({ file: "tests/package-lock.json" }), NO_VULN_CONTEXT).severity, "high", "dependencies are not demoted");
    assert.equal(r.assess(draft({ tool: "gitleaks", tool_severity: "secret", category: "secrets", rule_id: "x", file: "tests/.env", lane: "secrets" }), NO_VULN_CONTEXT).severity, "high");
  });

  it("refuses unmapped pairs", () => {
    assert.throws(() => r.assess(draft({ tool: "tsc", tool_severity: "warning" }), NO_VULN_CONTEXT), RefusedError);
  });
});

describe("routing (AC3)", () => {
  const routing = loadRubric("v1").routing;
  assert.ok(routing);
  const f = (lane: string, severity: "info" | "low" | "medium" | "high" | "critical", cve: string | null = null, cls = "tool") => ({ lane, severity, cve, class: cls });

  it("auto-confirms routine findings at or below medium", () => {
    assert.equal(autoConfirms(routing, f("lint", "low")), true);
    assert.equal(autoConfirms(routing, f("sca", "medium", "CVE-1")), true);
  });
  it("never auto-confirms the review set, ≥ high, judgment, or CVE-less SCA", () => {
    assert.equal(autoConfirms(routing, f("secrets", "low")), false);
    assert.equal(autoConfirms(routing, f("lint", "high")), false);
    assert.equal(autoConfirms(routing, f("lint", "low", null, "judgment")), false);
    assert.equal(autoConfirms(routing, f("sca", "low", null)), false);
    assert.equal(inReviewSet(routing, f("lint", "critical")), true);
  });
});

describe("EPSS / KEV (AC2)", () => {
  it("converts probabilities to basis points without floats, rounding half-up", () => {
    assert.equal(decimalToBp("0.21333"), 2133);
    assert.equal(decimalToBp("0.00005"), 1);
    assert.equal(decimalToBp("0.00004"), 0);
    assert.equal(decimalToBp("0.99995"), 10000);
    assert.equal(decimalToBp("1"), 10000);
    for (const bad of ["1.1", "-0.1", "0,5", "", "2"]) assert.throws(() => decimalToBp(bad), RefusedError, bad);
  });

  it("parses the published formats and rejects surprises", () => {
    const e = parseEpss(gzipSync(EPSS_CSV));
    assert.equal(e.published, "2026-10-07T12:00:27Z");
    assert.equal(e.scores.get("CVE-2021-23337"), 2133);
    assert.throws(() => parseEpss(gzipSync("cve,epss\n")), /header/);
    assert.throws(() => parseEpss(new TextEncoder().encode("not gzip")), /gzip/);
    assert.ok(parseKev(new TextEncoder().encode(KEV_JSON)).cves.has("CVE-2024-0001"));
    assert.throws(() => parseKev(new TextEncoder().encode("{}")), /shape/);
  });

  it("stores content-addressed snapshots, detects tampering, and reports gaps", async () => {
    const home = tmpDir();
    const epss = await syncContext(home, "epss", fixedClock("2026-10-07T00:00:00Z"), () => Promise.resolve(gzipSync(EPSS_CSV)));
    const again = await syncContext(home, "epss", fixedClock("2026-10-07T05:00:00Z"), () => Promise.resolve(gzipSync(EPSS_CSV)));
    assert.equal(again.id, epss.id);
    const { ctx: v, gaps } = loadVulnContext(home, { epss: { id: epss.id }, kev: null });
    assert.equal(v.epssBp("CVE-2021-23337"), 2133);
    assert.equal(v.epssBp("CVE-1999-9999"), null);
    assert.equal(v.kev("CVE-2021-23337"), undefined);
    assert.match(gaps.join(), /no KEV snapshot pinned/);
    writeFileSync(path.join(home, "snapshots", "epss", epss.id, "epss.csv.gz"), "x");
    assert.throws(() => verifyContext(home, "epss", epss.id), /altered/);
  });
});

describe("auto-confirm in a review + bulk disposition (AC3, AC4)", () => {
  const fixtureRoot = tmpDir();
  let fixture: FixtureRepo;
  before(async () => { fixture = await makeFixtureRepo(path.join(fixtureRoot, "fork")); });

  // Fake ruff: two diagnostics in app/main.py, reported with the physical worktree path like real ruff.
  const RUFF = `P=$(pwd -P); printf '[{"filename":"%s/app/main.py","code":"F401","message":"unused import","location":{"row":1},"end_location":{"row":1}},{"filename":"%s/app/main.py","code":"F841","message":"unused var","location":{"row":6},"end_location":{"row":6}}]' "$P" "$P"`;
  // Fake gitleaks: one redacted secret (review set: never auto-confirmed).
  const GITLEAKS = `while [ $# -gt 0 ]; do if [ "$1" = "--report-path" ]; then shift; printf '[{"RuleID":"generic-api-key","Description":"Generic key","StartLine":2,"EndLine":2,"Secret":"REDACTED","Match":"REDACTED","File":"config/deploy.env","Commit":"98f8ed3e3ef3e67a990e53ac3cb526772b79ab73","Fingerprint":"98f8:config/deploy.env:generic-api-key:2"}]' > "$1"; fi; shift; done`;

  it("confirms routine findings as rubric@v1, leaves the review set pending, and supports bulk decisions", async () => {
    const home = tmpDir();
    await seedHome(home);
    setFakeTool(home, "ruff", RUFF);
    setFakeTool(home, "gitleaks", GITLEAKS);
    const radr = cliRunner(home);
    await radr("init", "acme", "audit");
    assert.equal((await radr("scope", "-e", "acme-audit", "--source", fixture.dir)).code, 0);
    assert.equal((await radr("approve", "scope", "-e", "acme-audit")).code, 0);
    const r = await radr("review", "-e", "acme-audit");
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /auto-confirmed by rubric: 2/);

    const l = layout(home, "acme-audit");
    const dispositionEvents = () => new EventLog(l.events, fixedClock("2026-01-01T00:00:00Z")).read().filter((e) => e.type === "finding-disposition");
    assert.deepEqual(dispositionEvents().map((e) => e.actor), ["rubric@v1", "rubric@v1"]);
    assert.match((await radr("findings", "-e", "acme-audit", "--state", "pending")).out, /gitleaks\/generic-api-key/);

    assert.equal((await radr("disposition", "--lane", "nope", "dismissed", "--reason", "x", "-e", "acme-audit")).code, 1, "empty selector refuses");
    assert.equal((await radr("disposition", "--lane", "secrets", "dismissed", "-e", "acme-audit")).code, 1, "bulk needs --reason");
    const bulk = await radr("disposition", "--lane", "secrets", "dismissed", "--reason", "test credential, rotated", "-e", "acme-audit");
    assert.equal(bulk.code, 0, bulk.err);
    assert.match(bulk.out, /1 finding\(s\) → dismissed/);
    assert.equal(dispositionEvents().at(-1)?.data["reason"], "test credential, rotated");
    const again = await radr("disposition", "--rule", "F401", "dismissed", "--reason", "x", "-e", "acme-audit");
    assert.equal(again.code, 1, "confirmed → dismissed is not a legal transition");
  });
});
