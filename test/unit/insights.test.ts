// radr insights rules (PRD §16, §18): per-rule false-positive rates across engagements.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { layout } from "../../src/engagement/home.js";
import { ruleInsights } from "../../src/insights/rules.js";
import { cliRunner } from "../helpers/cli.js";
import { seedHome, setFakeTool } from "../helpers/fake-toolchain.js";
import { makeFixtureRepo, type FixtureRepo } from "../helpers/fixture-repo.js";
import { tmpDir } from "../helpers/tmp.js";

const fixtureRoot = tmpDir();
let fixture: FixtureRepo;
before(async () => { fixture = await makeFixtureRepo(path.join(fixtureRoot, "fork")); });

const RUFF = `P=$(pwd -P); printf '[{"filename":"%s/app/main.py","code":"F401","message":"unused import","location":{"row":1},"end_location":{"row":1}}]' "$P"`;
const GITLEAKS = `while [ $# -gt 0 ]; do if [ "$1" = "--report-path" ]; then shift; printf '[{"RuleID":"aws-access-token","Description":"AWS key","StartLine":2,"EndLine":2,"Secret":"REDACTED","Match":"REDACTED","File":"config/deploy.env","Commit":"98f8ed3e3ef3e67a990e53ac3cb526772b79ab73","Fingerprint":"98f8:config/deploy.env:aws-access-token:2"}]' > "$1"; fi; shift; done`;

async function home() {
  const h = tmpDir();
  await seedHome(h);
  setFakeTool(h, "ruff", RUFF);
  setFakeTool(h, "gitleaks", GITLEAKS);
  const radr = cliRunner(h);
  for (const slug of ["a", "b", "c"]) {
    const e = (...a: string[]) => radr(...a, "-e", `acme-${slug}`);
    await radr("init", "acme", slug);
    await e("scope", "--source", fixture.dir);
    await e("approve", "scope");
    assert.equal((await e("review")).code, 0);
  }
  // The secret is F-0001 in each: a false positive in one engagement, real in the other.
  await radr("disposition", "F-0001", "dismissed", "--reason", "documented test key", "-e", "acme-a");
  await radr("disposition", "F-0001", "confirmed", "-e", "acme-b");
  return { h, radr };
}

describe("radr insights rules", () => {
  it("rates false positives from human decisions only; rubric auto-confirms are counted apart", async () => {
    const t = await home();
    const r = ruleInsights(t.h);
    const secret = r.rules.find((x) => x.rule === "gitleaks/aws-access-token");
    assert.deepEqual(secret && [secret.findings, secret.falsePositives, secret.truePositives, secret.undecided, secret.fpRatePct, secret.engagements], [3, 1, 1, 1, 50, 3]);
    const lint = r.rules.find((x) => x.rule === "ruff/F401");
    assert.deepEqual(lint && [lint.auto, lint.truePositives, lint.fpRatePct], [3, 0, null], "auto-confirmed lint isn't a human judgment");
    assert.deepEqual(r.dismissals.get("gitleaks/aws-access-token")?.map((d) => [d.engagement, d.id, d.reason]), [["acme-a", "F-0001", "documented test key"]]);
  });

  it("the CLI hides rules with too few decisions, shows details per rule, and skips broken engagements", async () => {
    const t = await home();
    assert.match((await t.radr("insights", "rules")).out, /none yet/, "default: at least 3 decided");
    const one = await t.radr("insights", "rules", "--min-decided", "1");
    assert.match(one.out, /rules across 3 engagement\(s\)/);
    assert.match(one.out, /50%\s+1\s+1\s+0\s+1\s+gitleaks\/aws-access-token/);
    assert.doesNotMatch(one.out, /ruff\/F401/);
    const detail = await t.radr("insights", "rules", "--rule", "gitleaks/aws-access-token");
    assert.match(detail.out, /false-positive rate 50% \(1 dismissed, 1 confirmed by a person, 0 by the rubric, 1 undecided\)/);
    assert.match(detail.out, /acme-a {2}F-0001 {2}config\/deploy\.env:2 {2}documented test key/);
    const json = (await t.radr("insights", "rules", "--min-decided", "1", "--json")).out.trim().split("\n").map((x) => JSON.parse(x) as { rule: string; fpRatePct: number });
    assert.deepEqual(json.map((x) => [x.rule, x.fpRatePct]), [["gitleaks/aws-access-token", 50]]);

    appendFileSync(layout(t.h, "acme-c").events, "not json\n");
    const broken = await t.radr("insights", "rules", "--min-decided", "1");
    assert.match(broken.err, /skipped acme-c:/);
    assert.match(broken.out, /rules across 2 engagement\(s\)/);
  });
});
