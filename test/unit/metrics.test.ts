// M2 Wave 1: history + tests lanes (AC5), scorecard + triage (AC6), re-assessment, gitleaks dir mode.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { computeScorecard } from "../../src/address/scorecard.js";
import { UsageError } from "../../src/core/errors.js";
import { run } from "../../src/core/exec.js";
import { parseEngagement } from "../../src/engagement/config.js";
import type { DispositionState } from "../../src/findings/disposition.js";
import { ingest, readStore } from "../../src/findings/store.js";
import type { Finding, FindingDraft } from "../../src/findings/types.js";
import { busFactor, historyMetrics, parseGitLog, testMetrics, type Commit } from "../../src/lanes/metrics.js";
import { gitleaksAdapter, type CensusMetrics } from "../../src/normalize/adapters.js";
import { NO_VULN_CONTEXT, loadRubric } from "../../src/rubric/rubric.js";
import type { EngagementDoc } from "../../src/engagement/config.js";
import { makeFixtureRepo, type FixtureRepo } from "../helpers/fixture-repo.js";
import { tmpDir } from "../helpers/tmp.js";

const commit = (author: string, time: number, churn: Record<string, number> = {}): Commit => ({ sha: "a".repeat(40), author, time, churn });
const census = (files: Record<string, [string, number, number]>): CensusMetrics => ({
  languages: {}, totals: { files: 0, lines: 0, code: 0, comment: 0, blank: 0, complexity: 0 },
  files: Object.fromEntries(Object.entries(files).map(([f, [language, code, complexity]]) => [f, { language, code, complexity }])),
});

describe("history lane (AC5)", () => {
  const fixtureRoot = tmpDir();
  let fixture: FixtureRepo;
  before(async () => { fixture = await makeFixtureRepo(path.join(fixtureRoot, "fork")); });

  it("parses numstat (binary files count 0) and is deterministic on the real fixture history", async () => {
    const r = await run({ command: "git", args: ["log", "--format=%x00%H%x09%ae%x09%ct", "--numstat", "--no-renames", fixture.commits[2] ?? "", "--"], cwd: fixture.dir, inheritEnv: ["PATH"] });
    const commits = parseGitLog(r.stdout.toString());
    assert.equal(commits.length, 3);
    assert.deepEqual(commits.map((c) => c.sha), [...fixture.commits].reverse());
    assert.equal(commits[0]?.churn["config/deploy.env"], 2, "removal commit");
    const m = historyMetrics(commits, census({ "src/server.ts": ["TypeScript", 8, 2], "app/main.py": ["Python", 5, 0] }));
    assert.equal(m.bus_factor, 1);
    assert.equal(m.authors, 1);
    assert.deepEqual(m.window, { head_time: 1767434400, since: 1767434400 - 365 * 86400, commits: 3, all_commits: 3 });
    assert.equal(m.hotspots[0]?.file, "src/server.ts");
    assert.deepEqual(parseGitLog("\0" + "a".repeat(40) + "\tx@y\t5\n-\t-\tlogo.png\n").at(0)?.churn, { "logo.png": 0 });
    assert.throws(() => parseGitLog("\0garbage\n"), /unexpected git log header/);
  });

  it("bus factor: fewest authors covering ≥ 50% of commits, ties broken by email", () => {
    assert.equal(busFactor([]), 0);
    assert.equal(busFactor([commit("a", 1), commit("a", 2), commit("b", 3), commit("c", 4)]), 1);
    assert.equal(busFactor([commit("a", 1), commit("b", 2), commit("c", 3), commit("d", 4)]), 2);
    assert.equal(busFactor([commit("b", 1), commit("a", 2)]), 1);
  });

  it("windows to 365 days before the approved commit, never the wall clock", () => {
    const old = commit("old@x", 0, { "a.ts": 100 });
    const recent = commit("new@x", 400 * 86400, { "a.ts": 5 });
    const m = historyMetrics([old, recent], undefined);
    assert.equal(m.window.commits, 1);
    assert.equal(m.churn_total, 5);
    assert.equal(m.churn_hotspot_pct, null, "no census, no hotspot metric");
  });
});

describe("tests lane", () => {
  it("splits code into test and source by path, counting only program languages", () => {
    const m = testMetrics(census({
      "src/a.ts": ["TypeScript", 100, 3], "src/a.test.ts": ["TypeScript", 30, 0], "tests/test_x.py": ["Python", 20, 0],
      "app/x.py": ["Python", 100, 2], "README.md": ["Markdown", 500, 0], "package.json": ["JSON", 50, 0],
    }));
    assert.deepEqual(m, { test_files: 2, test_code: 50, source_files: 2, source_code: 200, test_ratio_pct: 25 });
    assert.equal(testMetrics(census({ "README.md": ["Markdown", 5, 0] }))["test_ratio_pct"], null);
  });
});

describe("scorecard (AC6)", () => {
  const spec = loadRubric("v1").scorecard;
  assert.ok(spec);
  const f = (over: Partial<Finding>): Finding => ({
    type: "finding", id: "F-0001", fingerprint: "x", class: "tool", severity: "low", rubric_version: "v1", epss_bp: null, kev: null, snippet_hash: null,
    lane: "lint", tool: "ruff", tool_version: "x", rule_id: "F401", category: "quality", file: "a.py", line: 1, end_line: 1, message: "m",
    tool_severity: "error", snippet: null, engine_fingerprint: null, cve: null, aliases: [], cvss: null, raw_ref: "r", tags: [], ...over,
  });
  const metrics = {
    census: census({ "src/a.ts": ["TypeScript", 1000, 1] }),
    tests: { test_ratio_pct: 60, source_code: 1000 },
    history: { bus_factor: 3, churn_hotspot_pct: 10 },
  };
  const lanesRun = new Set(["census", "lint", "secrets", "sca", "history", "tests"]);
  const none = new Map<string, DispositionState>();

  it("rates a healthy repo green and leaves unavailable metrics grey", () => {
    const card = computeScorecard(spec, { metrics, findings: [f({})], states: none, lanesRun });
    const byKey = Object.fromEntries(card.rows.map((r) => [r.key, r]));
    const lint = byKey["lint_errors_per_kloc_x10"];
    assert.ok(lint);
    assert.equal(lint.value, 10);
    assert.equal(lint.rating, "green");
    assert.equal(byKey["type_errors"]?.rating, "grey");
    assert.equal(byKey["duplication_pct"]?.rating, "grey");
    assert.equal(card.verdict, "healthy");
  });

  it("goes at-risk on a secret at HEAD, and dismissed findings don't count", () => {
    const secret = f({ id: "F-0002", lane: "secrets", tool: "gitleaks", tags: ["present-at-head"] });
    assert.equal(computeScorecard(spec, { metrics, findings: [secret], states: none, lanesRun }).verdict, "at-risk");
    assert.equal(computeScorecard(spec, { metrics, findings: [secret], states: new Map([["F-0002", "dismissed"]]), lanesRun }).verdict, "healthy");
  });

  it("treats KEV-listed dependencies as red, and a missing lane as grey (not green)", () => {
    const kev = f({ id: "F-0003", lane: "sca", severity: "medium", kev: true });
    const card = computeScorecard(spec, { metrics, findings: [kev], states: none, lanesRun });
    assert.equal(card.rows.find((r) => r.key === "dependency_vulns")?.rating, "red");
    const noSca = computeScorecard(spec, { metrics, findings: [], states: none, lanesRun: new Set(["census"]) });
    assert.equal(noSca.rows.find((r) => r.key === "dependency_vulns")?.rating, "grey");
  });

  it("needs-attention on three ambers", () => {
    const amber = { census: metrics.census, tests: { test_ratio_pct: 30, source_code: 1000 }, history: { bus_factor: 2, churn_hotspot_pct: 30 } };
    assert.equal(computeScorecard(spec, { metrics: amber, findings: [], states: none, lanesRun }).verdict, "needs-attention");
  });
});

describe("triage tier", () => {
  const yml = (tier: string, lanes: string) => `version: 1\nclient: acme\nslug: t\nengagement_type: triage\ntier: ${tier}\nsource: { origin: /x, sha: ${"a".repeat(40)} }\npaths: { include: ["**"], exclude: [] }\nstacks: []\nlanes: ${lanes}\nrubric: v1\nnetwork: { mode: offline, enforcement: declared }\nllm_policy: off\nclient_licenses: []\n`;
  it("requires its fixed lane set", () => {
    assert.equal(parseEngagement(yml("triage", "[census, lint, secrets, sca, history, tests]"), "e.yml").tier, "triage");
    assert.throws(() => parseEngagement(yml("triage", "[lint]"), "e.yml"), UsageError);
  });
});

describe("gitleaks dir mode (triage HEAD scan)", () => {
  it("rebuilds the fingerprint from the repo-relative path (no absolute path leaks into identity)", () => {
    const raw = JSON.stringify([{ RuleID: "aws-access-token", Description: "AWS", StartLine: 2, EndLine: 2, Secret: "REDACTED", Match: "REDACTED", File: "/REPO/config/deploy.env", Commit: "", Fingerprint: "/REPO/config/deploy.env:aws-access-token:2" }]);
    const [d] = gitleaksAdapter({ raw, rawRef: "r", repoRoot: "/REPO", toolVersion: "x", snippet: () => null, presentAtHead: () => true });
    assert.ok(d);
    assert.equal(d.engine_fingerprint, "config/deploy.env:aws-access-token:2");
    assert.deepEqual(d.tags, ["present-at-head"]);
  });
});

describe("re-assessment across runs", () => {
  const draft: FindingDraft = {
    lane: "secrets", tool: "gitleaks", tool_version: "x", rule_id: "aws-access-token", category: "secrets", file: "c.env", line: 2, end_line: 2, message: "m",
    tool_severity: "secret", snippet: null, engine_fingerprint: "c1:c.env:aws-access-token:2", cve: null, aliases: [], cvss: null, raw_ref: "r", tags: [],
  };
  const doc = { paths: { include: ["**"], exclude: [] } } as unknown as EngagementDoc;

  it("keeps the id but re-derives severity when the rubric changes, appending an updated record", () => {
    const file = path.join(tmpDir(), "findings.jsonl");
    const r1 = ingest(file, "R-0001", doc, loadRubric("v0"), [draft], NO_VULN_CONTEXT);
    assert.equal(r1.present[0]?.severity, "high");
    const r2 = ingest(file, "R-0002", doc, loadRubric("v1"), [draft], NO_VULN_CONTEXT);
    const [first] = r2.present;
    assert.ok(first);
    assert.equal(first.id, r1.present.at(0)?.id);
    assert.equal(first.severity, "critical");
    assert.equal(r2.updated, 1);
    assert.equal(readStore(file).findings[0]?.severity, "critical", "latest record wins");
    assert.equal(ingest(file, "R-0003", doc, loadRubric("v1"), [draft], NO_VULN_CONTEXT).updated, 0);
  });
});
