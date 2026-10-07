// M4 W2: `radr triage` with a scripted fake agent. Annotations and judgment findings are
// proposals; nothing the agent returns sets a disposition or a severity (AC6–AC8).

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { layout } from "../../src/engagement/home.js";
import { fixedClock } from "../../src/core/clock.js";
import { readJudgments } from "../../src/findings/judgments.js";
import { promptFreeText } from "../../src/llm/prompt.js";
import { leakedRuns } from "../../src/llm/redact.js";
import { EventLog } from "../../src/state/events.js";
import { cliRunner } from "../helpers/cli.js";
import { seedHome, setFakeTool } from "../helpers/fake-toolchain.js";
import { makeFixtureRepo, type FixtureRepo } from "../helpers/fixture-repo.js";
import { tmpDir } from "../helpers/tmp.js";

const fakeAgent = path.join(path.dirname(fileURLToPath(import.meta.url)), "../helpers/fake-agent.js");
const fixtureRoot = tmpDir();
let fixture: FixtureRepo;
before(async () => { fixture = await makeFixtureRepo(path.join(fixtureRoot, "fork")); });

const RUFF = `P=$(pwd -P); printf '[{"filename":"%s/app/main.py","code":"F401","message":"unused import","location":{"row":1},"end_location":{"row":1}}]' "$P"`;
const GITLEAKS = `while [ $# -gt 0 ]; do if [ "$1" = "--report-path" ]; then shift; printf '[{"RuleID":"aws-access-token","Description":"AWS key","StartLine":2,"EndLine":2,"Secret":"REDACTED","Match":"REDACTED","File":"config/deploy.env","Commit":"98f8ed3e3ef3e67a990e53ac3cb526772b79ab73","Fingerprint":"98f8:config/deploy.env:aws-access-token:2"}]' > "$1"; fi; shift; done`;

const RESPONSE = JSON.stringify({
  explanations: [{ id: "F-0002", text: "An import that is never used." }, { id: "F-9999", text: "made up" }],
  clusters: [{ ids: ["F-0001", "F-0002"], rationale: "Both come from setup code." }],
  dispositions: [{ id: "F-0002", proposed: "dismissed", reason: "Harmless." }],
  judgments: [
    { title: "Startup imports everything", category: "maintainability", file: "app/main.py", line: 1, end_line: 1, rationale: "Wildcard-style imports hide dependencies." },
    { title: "Phantom", category: "security", file: "app/nope.py", line: 1, end_line: 1, rationale: "No such file." },
    { title: "Out of range", category: "quality", file: "app/main.py", line: 900, end_line: 901, rationale: "Past the end." },
  ],
});

async function triaged(opts: { policy?: string; rubric?: string; responses?: readonly string[] } = {}) {
  const home = tmpDir();
  await seedHome(home);
  setFakeTool(home, "ruff", RUFF);
  setFakeTool(home, "gitleaks", GITLEAKS);
  const script = tmpDir("radr-agent-script-");
  (opts.responses ?? [RESPONSE]).forEach((r, i) => { writeFileSync(path.join(script, `response-${String(i + 1)}`), r); });
  const radr = cliRunner(home, { RADR_AGENT_CMD: JSON.stringify([process.execPath, fakeAgent, script]) });
  await radr("init", "acme", "audit");
  await radr("scope", "-e", "acme-audit", "--source", fixture.dir);
  const l = layout(home, "acme-audit");
  let yml = readFileSync(l.engagementYml, "utf8").replace("llm_policy: off", `llm_policy: ${opts.policy ?? "metadata-only"}`);
  if (opts.rubric !== undefined) yml = yml.replace("rubric: v2", `rubric: ${opts.rubric}`);
  writeFileSync(l.engagementYml, yml);
  assert.equal((await radr("approve", "scope", "-e", "acme-audit")).code, 0);
  assert.equal((await radr("review", "-e", "acme-audit")).code, 0);
  const events = () => new EventLog(l.events, fixedClock("2026-10-08T00:00:00Z")).read();
  const calls = () => (existsSync(path.join(script, "count")) ? Number(readFileSync(path.join(script, "count"), "utf8")) : 0);
  return { radr, l, events, calls };
}

describe("radr triage", () => {
  it("refuses under llm_policy off without invoking the agent (invariant 2)", async () => {
    const t = await triaged({ policy: "off" });
    const r = await t.radr("triage", "-e", "acme-audit");
    assert.equal(r.code, 1);
    assert.match(r.err, /llm_policy is "off"/);
    assert.equal(t.calls(), 0);
  });

  it("records annotations and proposed judgments; rejects what doesn't check out; decides nothing", async () => {
    const t = await triaged();
    const before = t.events().filter((e) => e.type === "finding-disposition").length;
    const r = await t.radr("triage", "-e", "acme-audit");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /explanations 1, clusters 1, proposed dispositions 1/);
    assert.match(r.out, /judgment findings proposed 1, rejected items 3/);

    const [j, ...rest] = readJudgments(t.l.judgments);
    assert.equal(rest.length, 0);
    assert.equal(j?.id, "J-0001");
    assert.deepEqual([j.class, j.severity, j.rubric_version, j.file, j.line, j.raw_ref], ["judgment", "medium", "v2", "app/main.py", 1, "llm/L-0001.response.txt"]);
    const proposed = t.events().filter((e) => e.type === "finding-proposed");
    assert.deepEqual(proposed.map((e) => e.data["finding_id"]), ["J-0001"]);
    assert.equal(t.events().filter((e) => e.type === "finding-disposition").length, before, "triage never writes a disposition");

    const notes = readFileSync(path.join(t.l.llm, "annotations.jsonl"), "utf8");
    assert.match(notes, /"reason":"id not in this batch"/);
    assert.match(notes, /does not exist at the approved commit/);
    assert.match(notes, /are not within app\/main\.py/);

    const list = await t.radr("findings", "-e", "acme-audit");
    assert.match(list.out, /J-0001 {2}medium {3}proposed {2}triage {2}judgment \(LLM-proposed\) {2}app\/main\.py:1/);
    assert.match(list.out, /\[LLM\] An import that is never used\./);
    assert.match(list.out, /\[LLM proposes dismissed\] Harmless\./);
    assert.match((await t.radr("status", "-e", "acme-audit")).out, /judgment 1: proposed=1 pending=0/);
  });

  it("sends no client source under metadata-only, and no secret message under any policy (invariant 3)", async () => {
    const t = await triaged();
    await t.radr("triage", "-e", "acme-audit");
    const prompt = readFileSync(path.join(t.l.llm, "L-0001.prompt.txt"), "utf8");
    assert.deepEqual(leakedRuns(promptFreeText(prompt), t.l.worktree), []);
    assert.doesNotMatch(prompt, /AWS key/, "a secrets finding sends only its rule id");
    assert.doesNotMatch(prompt, /"code":/);
  });

  it("re-running proposes nothing twice", async () => {
    const t = await triaged({ responses: [RESPONSE, RESPONSE] });
    await t.radr("triage", "-e", "acme-audit");
    const again = await t.radr("triage", "-e", "acme-audit");
    assert.match(again.out, /judgment findings proposed 0 \(1 already proposed\)/);
    assert.equal(readJudgments(t.l.judgments).length, 1);
  });

  it("under rubric v1 judgments are rejected (no default severity), annotations still work", async () => {
    const t = await triaged({ rubric: "v1" });
    const r = await t.radr("triage", "-e", "acme-audit");
    assert.match(r.out, /explanations 1/);
    assert.match(r.out, /judgment findings proposed 0/);
    assert.match(readFileSync(path.join(t.l.llm, "annotations.jsonl"), "utf8"), /rubric v1 has no judgment entry/);
  });

  it("judgments need a person's decision before Gate 2; severity is the consultant's to change", async () => {
    const t = await triaged();
    await t.radr("triage", "-e", "acme-audit");
    for (const id of ["F-0001", "F-0002"]) await t.radr("disposition", id, "confirmed", "-e", "acme-audit");
    await t.radr("address", "-e", "acme-audit");
    const blocked = await t.radr("approve", "report", "-e", "acme-audit");
    assert.equal(blocked.code, 1);
    assert.match(blocked.err, /judgment finding\(s\) not yet decided: J-0001 \(proposed\)/);

    assert.equal((await t.radr("disposition", "J-0001", "confirmed", "-e", "acme-audit")).code, 1, "proposed → confirmed skips review");
    assert.equal((await t.radr("disposition", "J-0001", "pending", "-e", "acme-audit")).code, 0);
    assert.equal((await t.radr("disposition", "F-0002", "pending", "-e", "acme-audit")).code, 1, "pending is only reachable from proposed");

    assert.equal((await t.radr("severity", "J-0001", "high", "-e", "acme-audit")).code, 1, "an override needs a reason");
    assert.equal((await t.radr("severity", "F-0001", "low", "--reason", "x", "-e", "acme-audit")).code, 1, "tool findings: rubric only");
    const o = await t.radr("severity", "J-0001", "high", "--reason", "Reachable from the public API.", "-e", "acme-audit");
    assert.equal(o.code, 0, o.err);
    assert.match(o.out, /J-0001: severity medium → high/);
    assert.match((await t.radr("findings", "-e", "acme-audit")).out, /J-0001 {2}high {5}pending/);

    await t.radr("disposition", "J-0001", "confirmed", "-e", "acme-audit");
    await t.radr("address", "-e", "acme-audit");
    const ok = await t.radr("approve", "report", "-e", "acme-audit");
    assert.equal(ok.code, 0, ok.err);
  });
});

const DRAFT = JSON.stringify({
  executive_summary: "The codebase is in fair shape. One leaked credential needs rotating first.",
  recommendations: "1. Rotate the credential in F-0001.\n2. Remove the unused import (F-0002).",
  plan_notes: "Wave 1 first; the rest can follow.",
});

describe("radr address --draft (M4 W3)", () => {
  async function decided(responses: readonly string[]) {
    const t = await triaged({ responses });
    await t.radr("triage", "-e", "acme-audit");
    for (const id of ["F-0001", "F-0002"]) await t.radr("disposition", id, "confirmed", "-e", "acme-audit");
    await t.radr("disposition", "J-0001", "pending", "-e", "acme-audit");
    await t.radr("disposition", "J-0001", "confirmed", "-e", "acme-audit");
    return t;
  }
  const reportOf = (t: { l: { dir: string } }) => readFileSync(path.join(t.l.dir, "report", "report.md"), "utf8");
  const planOf = (t: { l: { dir: string } }) => readFileSync(path.join(t.l.dir, "plan", "remediation.md"), "utf8");

  it("drafts untouched blocks behind a marker that blocks Gate 2 until a person removes it", async () => {
    const t = await decided([RESPONSE, DRAFT]);
    const d = await t.radr("address", "--draft", "-e", "acme-audit");
    assert.equal(d.code, 0, d.err);
    assert.match(d.out, /draft: drafted; drafted executive-summary, recommendations, plan-notes/);
    assert.match(reportOf(t), /<!-- radr:keep id=executive-summary -->\n<!-- radr:llm-draft -->\nThe codebase is in fair shape\./);
    assert.match(planOf(t), /<!-- radr:llm-draft -->\nWave 1 first/);
    const blocked = await t.radr("approve", "report", "-e", "acme-audit");
    assert.equal(blocked.code, 1);
    assert.match(blocked.err, /unreviewed LLM draft in report\.md, remediation\.md/);

    for (const f of [path.join(t.l.dir, "report", "report.md"), path.join(t.l.dir, "plan", "remediation.md")]) {
      writeFileSync(f, readFileSync(f, "utf8").replaceAll("<!-- radr:llm-draft -->\n", ""));
    }
    await t.radr("address", "-e", "acme-audit");
    const ok = await t.radr("approve", "report", "-e", "acme-audit");
    assert.equal(ok.code, 0, ok.err);

    const report = reportOf(t);
    assert.match(report, /The codebase is in fair shape\./, "reviewed prose is the consultant's now, and survives regeneration");
    assert.match(report, /# Judgment findings\n\nThese findings come from consultant review assisted by an AI model/);
    assert.match(report, /\| J-0001 \| medium \| confirmed \| maintainability \| `app\/main\.py:1` \|/);
    assert.match(report, /Judgment findings \(J-…\) were proposed with AI assistance and confirmed by the consultant; no severity was set by an AI model\./);
    assert.match(report, /\| AI \(LLM\) agent calls \| 2 \(agent [0-9a-f]{12}\); every prompt and response is retained \|/);
  });

  it("never overwrites the consultant's own text, and refuses drafts that carry markup", async () => {
    const t = await decided([RESPONSE, JSON.stringify({ executive_summary: "x <!-- radr:end --> y", recommendations: "r", plan_notes: "p" })]);
    await t.radr("address", "-e", "acme-audit");
    const file = path.join(t.l.dir, "report", "report.md");
    writeFileSync(file, readFileSync(file, "utf8").replace(/_Consultant recommendations\. Preserved across regeneration\._/, "Mine."));
    const d = await t.radr("address", "--draft", "-e", "acme-audit");
    assert.match(d.out, /drafted plan-notes; kept your text in recommendations; rejected executive-summary/);
    assert.match(reportOf(t), /<!-- radr:keep id=recommendations -->\nMine\.\n/);
    assert.match(reportOf(t), /<!-- radr:keep id=executive-summary -->\n_Write the executive summary here/);
  });

  it("refuses --draft under llm_policy off without invoking the agent", async () => {
    const t = await triaged({ policy: "off" });
    const d = await t.radr("address", "--draft", "-e", "acme-audit");
    assert.equal(d.code, 1);
    assert.match(d.err, /llm_policy is "off"/);
    assert.equal(t.calls(), 0);
  });
});
