// M4 AC11: the opt-in real-agent eval. It costs money and needs credentials, so it never runs in
// CI. Run it with:
//
//   RADR_E2E_AGENT=1 RADR_AGENT_CMD='[...]' RADR_AGENT_OUTPUT=claude-json \
//     RADR_AGENT_ENV=ANTHROPIC_API_KEY ANTHROPIC_API_KEY=… npm test
//
// It runs triage and address --draft against a real agent on the fixture repo (with fake tools:
// the agent is what is being evaluated), checks invariants 3 and 5 on what was actually sent and
// recorded, and reports the quality metrics: schema-valid rate, anchor-valid rate, and judgments
// proposed. RADR_E2E_AGENT_POLICY picks the policy (default metadata-only).

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { layout } from "../../src/engagement/home.js";
import { fixedClock } from "../../src/core/clock.js";
import { promptFreeText } from "../../src/llm/prompt.js";
import { leakedRuns } from "../../src/llm/redact.js";
import { llmMetrics } from "../../src/state/llm-metrics.js";
import { readAnnotations } from "../../src/llm/triage.js";
import { EventLog } from "../../src/state/events.js";
import { cliRunner } from "../helpers/cli.js";
import { seedHome, setFakeTool } from "../helpers/fake-toolchain.js";
import { makeFixtureRepo, type FixtureRepo } from "../helpers/fixture-repo.js";
import { tmpDir } from "../helpers/tmp.js";

const enabled = process.env["RADR_E2E_AGENT"] === "1" && (process.env["RADR_AGENT_CMD"] ?? "") !== "";
const policy = process.env["RADR_E2E_AGENT_POLICY"] ?? "metadata-only";
const RUFF = `P=$(pwd -P); printf '[{"filename":"%s/app/main.py","code":"F401","message":"unused import","location":{"row":1},"end_location":{"row":1}}]' "$P"`;
const GITLEAKS = `while [ $# -gt 0 ]; do if [ "$1" = "--report-path" ]; then shift; printf '[{"RuleID":"aws-access-token","Description":"AWS key","StartLine":2,"EndLine":2,"Secret":"REDACTED","Match":"REDACTED","File":"config/deploy.env","Commit":"98f8ed3e3ef3e67a990e53ac3cb526772b79ab73","Fingerprint":"98f8:config/deploy.env:aws-access-token:2"}]' > "$1"; fi; shift; done`;

/** Pass the agent its configuration and the variables RADR_AGENT_ENV names (radr filters again). */
function agentEnv(): Record<string, string> {
  const names = ["HOME", "RADR_AGENT_CMD", "RADR_AGENT_OUTPUT", "RADR_AGENT_ENV", ...(process.env["RADR_AGENT_ENV"] ?? "").split(/[\s,]+/)];
  return Object.fromEntries(names.filter((n) => n !== "" && process.env[n] !== undefined).map((n) => [n, process.env[n] ?? ""]));
}

describe("real-agent eval (opt-in: RADR_E2E_AGENT=1)", { skip: !enabled }, () => {
  const fixtureRoot = tmpDir();
  let fixture: FixtureRepo;
  before(async () => { fixture = await makeFixtureRepo(path.join(fixtureRoot, "fork")); });

  it("triage and drafting keep the invariants; reports signal quality", { timeout: 30 * 60 * 1000 }, async (t) => {
    const home = tmpDir();
    await seedHome(home);
    setFakeTool(home, "ruff", RUFF);
    setFakeTool(home, "gitleaks", GITLEAKS);
    const radr = cliRunner(home, agentEnv());
    await radr("init", "acme", "audit");
    await radr("scope", "-e", "acme-audit", "--source", fixture.dir);
    const l = layout(home, "acme-audit");
    writeFileSync(l.engagementYml, readFileSync(l.engagementYml, "utf8").replace("llm_policy: off", `llm_policy: ${policy}`));
    assert.equal((await radr("approve", "scope", "-e", "acme-audit")).code, 0);
    assert.equal((await radr("review", "-e", "acme-audit")).code, 0);
    const before = new EventLog(l.events, fixedClock("2026-10-08T00:00:00Z")).read().length;

    const tr = await radr("triage", "-e", "acme-audit");
    t.diagnostic(tr.out);
    assert.equal(tr.code, 0, tr.err);
    await radr("address", "-e", "acme-audit");
    const dr = await radr("address", "--draft", "-e", "acme-audit");
    t.diagnostic(dr.out);
    assert.equal(dr.code, 0, dr.err);

    const events = new EventLog(l.events, fixedClock("2026-10-08T00:00:00Z")).read();
    const added = events.slice(before);
    // Invariant 5: the agent's work produced call records, proposals and a report; no decisions.
    assert.deepEqual([...new Set(added.map((e) => e.type))].filter((x) => !["llm-call", "finding-proposed", "report-generated"].includes(x)), []);
    // Invariant 3 (metadata-only): no prompt quotes the repository.
    const prompts = existsSync(l.llm) ? readdirSync(l.llm).filter((f) => f.endsWith(".prompt.txt")) : [];
    assert.ok(prompts.length > 0);
    if (policy === "metadata-only") {
      for (const p of prompts) assert.deepEqual(leakedRuns(promptFreeText(readFileSync(path.join(l.llm, p), "utf8")), l.worktree), [], p);
    }

    const m = llmMetrics(events);
    const run = String(events.findLast((e) => e.type === "run-completed")?.data["run_id"]);
    const anchorRejects = readAnnotations(l, run).filter((a) => a.type === "rejected" && a.item.startsWith("judgment ")).length;
    const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${String(Math.round((100 * n) / d))}%`);
    t.diagnostic(`policy ${policy}: ${String(m.calls)} call(s); schema-valid ${pct(m.succeeded, m.calls)}; judgments proposed ${String(m.judgmentsProposed)}, anchor-valid ${pct(m.judgmentsProposed, m.judgmentsProposed + anchorRejects)}`);
  });
});
