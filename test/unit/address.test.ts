// M2 Wave 4: Address (AC10) + Gate 2 (AC11).

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertReportApproved } from "../../src/address/gate2.js";
import { applyKeeps, code, esc, extractKeeps, keep } from "../../src/address/markdown.js";
import { buildPlan } from "../../src/address/plan.js";
import { addressPaths } from "../../src/address/report.js";
import { fixedClock } from "../../src/core/clock.js";
import { layout } from "../../src/engagement/home.js";
import type { DispositionState } from "../../src/findings/disposition.js";
import type { Finding } from "../../src/findings/types.js";
import { EventLog } from "../../src/state/events.js";
import { cliRunner } from "../helpers/cli.js";
import { seedHome, setFakeTool } from "../helpers/fake-toolchain.js";
import { makeFixtureRepo, type FixtureRepo } from "../helpers/fixture-repo.js";
import { tmpDir } from "../helpers/tmp.js";

describe("markdown safety", () => {
  it("escapes what pandoc interprets inline, and nothing else", () => {
    assert.equal(esc("a*b_c `d` [e](f) <g> | $h @i ~j ^k \\l"), "a\\*b\\_c \\`d\\` \\[e\\](f) \\<g\\> \\| \\$h \\@i \\~j \\^k \\\\l");
    assert.equal(esc("Known-vulnerable (high). Fix!"), "Known-vulnerable (high). Fix!");
    assert.equal(esc("line1\nline2"), "line1 line2");
  });
  it("code spans can't be broken out of", () => {
    assert.equal(code("a`b"), "``a`b``");
    assert.equal(code("`x`"), "`` `x` ``");
  });
  it("keep-blocks survive regeneration; orphans are preserved, never dropped", () => {
    const old = `# T\n${keep("summary", "MY WORDS")}\n${keep("gone", "OLD NOTE")}\n`;
    const regenerated = `# T v2\n${keep("summary", "_default_")}\n`;
    const out = applyKeeps(regenerated, extractKeeps(old));
    assert.match(out, /MY WORDS/);
    assert.doesNotMatch(out, /_default_/);
    assert.match(out, /## Preserved notes[\s\S]*OLD NOTE/);
  });
});

describe("remediation plan", () => {
  const f = (id: string, over: Partial<Finding>): Finding => ({
    type: "finding", id, fingerprint: id, class: "tool", severity: "low", rubric_version: "v1", epss_bp: null, kev: null, snippet_hash: null,
    lane: "lint", tool: "ruff", tool_version: "x", rule_id: "F401", category: "quality", file: "a.py", line: 1, end_line: 1, message: "m",
    tool_severity: "error", snippet: null, engine_fingerprint: null, cve: null, aliases: [], cvss: null, raw_ref: "r", tags: [], ...over,
  });
  it("groups by kind, sizes by rubric, sequences waves by severity, skips dismissed and waived", () => {
    const findings = [
      f("F-0001", {}), f("F-0002", {}),
      f("F-0003", { lane: "sca", category: "dependency", severity: "critical", cve: "CVE-1", tags: ["package:lodash@4.17.20"] }),
      f("F-0004", { lane: "sca", category: "dependency", severity: "high", cve: "CVE-2", tags: ["package:lodash@4.17.20"] }),
      f("F-0005", { lane: "secrets", tool: "gitleaks", category: "secrets", severity: "critical", tags: ["history-only"] }),
      f("F-0006", { severity: "medium" }), f("F-0007", { lane: "types", tool: "tsc" }),
    ];
    const states = new Map<string, DispositionState>([["F-0002", "dismissed"], ["F-0007", "waived"]]);
    const waves = buildPlan(findings, states, { "dependency-upgrade": "S", "secret-rotation": "S", "lint-cleanup": "S" });
    const w1 = waves[0]?.items ?? [];
    assert.deepEqual(w1.map((i) => i.title), ["Upgrade lodash@4.17.20 (CVE-1, CVE-2)", "Rotate the credential exposed in git history (a.py); it is no longer in the current code, but anyone with the repository can recover it"]);
    assert.deepEqual(w1[0]?.findings, ["F-0003", "F-0004"]);
    const all = waves.flatMap((w) => w.items.flatMap((i) => i.findings));
    assert.ok(!all.includes("F-0002") && !all.includes("F-0007"), "dismissed and waived findings need no remediation");
    assert.deepEqual(waves[1]?.items.map((i) => i.findings), [["F-0001", "F-0006"]], "the group takes its most severe member's wave");
  });
});

describe("radr address + approve report (AC10, AC11)", () => {
  const fixtureRoot = tmpDir();
  let fixture: FixtureRepo;
  before(async () => { fixture = await makeFixtureRepo(path.join(fixtureRoot, "fork")); });

  const RUFF = `P=$(pwd -P); printf '[{"filename":"%s/app/main.py","code":"F401","message":"unused import","location":{"row":1},"end_location":{"row":1}}]' "$P"`;
  const GITLEAKS = `while [ $# -gt 0 ]; do if [ "$1" = "--report-path" ]; then shift; printf '[{"RuleID":"aws-access-token","Description":"AWS key","StartLine":2,"EndLine":2,"Secret":"REDACTED","Match":"REDACTED","File":"config/deploy.env","Commit":"98f8ed3e3ef3e67a990e53ac3cb526772b79ab73","Fingerprint":"98f8:config/deploy.env:aws-access-token:2"}]' > "$1"; fi; shift; done`;

  async function reviewed(opts: { failRuff?: boolean } = {}) {
    const home = tmpDir();
    await seedHome(home);
    setFakeTool(home, "ruff", opts.failRuff === true ? "exit 3" : RUFF);
    setFakeTool(home, "gitleaks", GITLEAKS);
    const radr = cliRunner(home);
    await radr("init", "acme", "audit");
    await radr("scope", "-e", "acme-audit", "--source", fixture.dir);
    assert.equal((await radr("approve", "scope", "-e", "acme-audit")).code, 0);
    assert.equal((await radr("review", "-e", "acme-audit")).code, 0);
    const l = layout(home, "acme-audit");
    return { radr, l, clock: fixedClock("2026-10-08T00:00:00Z", 1000) };
  }

  it("generates deterministic documents and walks Gate 2's refusals to a sign-off", async () => {
    const { radr, l, clock } = await reviewed();
    assert.equal((await radr("approve", "report", "-e", "acme-audit")).code, 1, "no report yet");
    assert.equal((await radr("address", "-e", "acme-audit")).code, 0);
    const p = addressPaths(l);
    const first = readFileSync(p.report, "utf8");
    assert.match(first, /^---\ntitle: "Code review: acme \/ audit"/);
    assert.match(first, /\| F-0001 \| critical \| pending \|/);
    // M3 W4: the methodology states the SAST support bar for the stacks reviewed, and what no tool covers.
    assert.match(first, /\*\*Static analysis \(SAST\) coverage\*\*/);
    assert.match(first, /\| python \| supported \| 10\/10 \|/);
    assert.match(first, /\| typescript-javascript \| supported \| 10\/10 \|/);
    assert.doesNotMatch(first, /\| rust \|/, "only the reviewed stacks are listed");
    assert.match(first, /Missing Authorization \(CWE-862\)/);
    assert.doesNotMatch(first, /# Licenses/, "no license lane, no license section");

    const pending = await radr("approve", "report", "-e", "acme-audit");
    assert.equal(pending.code, 1);
    assert.match(pending.err, /still pending: F-0001/);

    await radr("disposition", "F-0001", "confirmed", "-e", "acme-audit");
    const stale = await radr("approve", "report", "-e", "acme-audit");
    assert.equal(stale.code, 1);
    assert.match(stale.err, /out of date/, "the report still says pending: it must be regenerated");

    writeFileSync(p.report, readFileSync(p.report, "utf8").replace("_Write the executive summary here. radr preserves this block when the report is regenerated._", "Two critical issues; both fixable this week."));
    await radr("address", "-e", "acme-audit");
    const regenerated = readFileSync(p.report, "utf8");
    assert.match(regenerated, /Two critical issues; both fixable this week\./, "consultant prose survives regeneration");
    await radr("address", "-e", "acme-audit");
    assert.equal(readFileSync(p.report, "utf8"), regenerated, "regeneration is byte-identical");

    const ok = await radr("approve", "report", "-e", "acme-audit");
    assert.equal(ok.code, 0, ok.err);
    assert.doesNotThrow(() => assertReportApproved(l, clock));

    writeFileSync(p.remediation, `${readFileSync(p.remediation, "utf8")}\nsneaky edit\n`);
    assert.throws(() => assertReportApproved(l, clock), /changed since approval: remediation_hash/);
  });

  it("refuses review-set findings confirmed only by the rubric", async () => {
    const { radr, l } = await reviewed();
    new EventLog(l.events, fixedClock("2026-10-08T00:00:00Z")).append("finding-disposition", "rubric@v1", { finding_id: "F-0001", from: "pending", to: "confirmed", reason: "test" });
    await radr("address", "-e", "acme-audit");
    const r = await radr("approve", "report", "-e", "acme-audit");
    assert.equal(r.code, 1);
    assert.match(r.err, /confirmed only by the rubric, not by a person: F-0001/);
  });

  it("refuses a partial run unless the gap is explicitly accepted (and records why)", async () => {
    const { radr, l } = await reviewed({ failRuff: true });
    await radr("disposition", "F-0001", "confirmed", "-e", "acme-audit");
    await radr("address", "-e", "acme-audit");
    const r = await radr("approve", "report", "-e", "acme-audit");
    assert.equal(r.code, 1);
    assert.match(r.err, /partial \(lint\)/);
    const ok = await radr("approve", "report", "--accept-partial", "ruff crashed on the client's generated code; lint covered by eslint", "-e", "acme-audit");
    assert.equal(ok.code, 0, ok.err);
    const ev = new EventLog(l.events, fixedClock("2026-10-08T00:00:00Z")).read().findLast((e) => e.type === "report-approved");
    assert.match(String(ev?.data["accepted_partial"]), /ruff crashed/);
  });
});

describe("render (unit)", () => {
  it("derives the PDF timestamp from the document date, never the wall clock", async () => {
    const { epochOf } = await import("../../src/address/render.js");
    assert.equal(epochOf("2026-10-07"), 1791331200);
    assert.throws(() => epochOf("10/07/2026"), /invalid document date/);
  });
});
