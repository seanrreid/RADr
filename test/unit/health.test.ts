// M3 W2 health lanes through the real runner, with fake tools: maint findings + metrics feed the
// scorecard (AC7); image-only lanes are refused in host mode at scope time; hygiene is optional.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { layout } from "../../src/engagement/home.js";
import { parseEngagement } from "../../src/engagement/config.js";
import { UsageError } from "../../src/core/errors.js";
import { Matrix } from "../../src/matrix/matrix.js";
import { cliRunner } from "../helpers/cli.js";
import { seedHome, setFakeJscpd, setFakeLizard, setFakeTool } from "../helpers/fake-toolchain.js";
import { makeFixtureRepo, type FixtureRepo } from "../helpers/fixture-repo.js";
import { tmpDir } from "../helpers/tmp.js";

const fixtureRoot = tmpDir();
let fixture: FixtureRepo;
before(async () => { fixture = await makeFixtureRepo(path.join(fixtureRoot, "fork")); });

const LIZARD_CSV = [
  '40,22,300,1,40,"handler@1-40@src/server.ts","src/server.ts","handler","handler( input )",1,40',
  '3,1,10,0,3,"ok@1-3@app/main.py","app/main.py","ok","ok( )",1,3',
  '3,1,10,0,3,"ok2@5-7@app/main.py","app/main.py","ok2","ok2( )",5,7',
  '3,1,10,0,3,"ok3@9-11@app/main.py","app/main.py","ok3","ok3( )",9,11',
].join("\n");

const JSCPD = {
  duplicates: [{ format: "typescript", lines: 6, fragment: "x", tokens: 60,
    firstFile: { name: "src/server.ts", start: 1, end: 6 }, secondFile: { name: "app/main.py", start: 1, end: 6 } }],
  statistics: { total: { lines: 200, duplicatedLines: 12, percentage: 6.0 } },
};

async function reviewed(edit?: (yml: string) => string) {
  const home = tmpDir();
  await seedHome(home);
  setFakeLizard(home, `printf '%s\\n' '${LIZARD_CSV.replace(/'/g, "'\\''")}'`);
  setFakeJscpd(home, JSCPD);
  const radr = cliRunner(home);
  await radr("init", "acme", "audit");
  const s = await radr("scope", "-e", "acme-audit", "--source", fixture.dir);
  assert.equal(s.code, 0, s.err);
  const l = layout(home, "acme-audit");
  if (edit !== undefined) {
    writeFileSync(l.engagementYml, edit(readFileSync(l.engagementYml, "utf8")));
    const again = await radr("scope", "-e", "acme-audit");
    assert.equal(again.code, 0, again.err);
  }
  const a = await radr("approve", "scope", "-e", "acme-audit");
  assert.equal(a.code, 0, a.err);
  const r = await radr("review", "-e", "acme-audit");
  return { home, radr, l, r };
}

describe("maint lane (lizard + jscpd)", () => {
  it("emits complexity and duplication findings, and fills the scorecard rows (AC7)", async () => {
    const { radr, l, r } = await reviewed();
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /run R-0001: complete/);
    const findings = (await radr("findings", "-e", "acme-audit", "--json")).out.trim().split("\n").map((x) => JSON.parse(x) as Record<string, unknown>);
    const cc = findings.find((f) => f["tool"] === "lizard");
    assert.equal(cc?.["rule_id"], "cyclomatic-complexity");
    assert.equal(cc["severity"], "low");
    assert.match(String(cc["message"]), /handler has cyclomatic complexity 22/);
    assert.equal(findings.find((f) => f["tool"] === "jscpd")?.["severity"], "info");

    // lizard was handed an explicit, sorted file list (never a directory walk).
    const list = readFileSync(path.join(l.raw, "R-0001", "maint.attempt-1", "lizard-files.txt"), "utf8").trim().split("\n");
    assert.deepEqual(list, [...list].sort());
    assert.ok(list.includes("src/server.ts") && list.includes("app/main.py"));

    const card = JSON.parse((await radr("scorecard", "-e", "acme-audit", "--json")).out) as { rows: { key: string; value: unknown; rating: string }[] };
    const row = (k: string) => card.rows.find((x) => x.key === k);
    assert.deepEqual([row("complex_functions_pct")?.value, row("complex_functions_pct")?.rating], [25, "red"]); // 1 of 4 functions
    assert.deepEqual([row("duplication_pct")?.value, row("duplication_pct")?.rating], [6, "amber"]); // 12 of 200 lines
  });

  it("a lizard parse failure is a partial lane, never a guess", async () => {
    const home = tmpDir();
    await seedHome(home);
    setFakeLizard(home, "echo 'not,csv'");
    const radr = cliRunner(home);
    await radr("init", "acme", "audit");
    await radr("scope", "-e", "acme-audit", "--source", fixture.dir);
    await radr("approve", "scope", "-e", "acme-audit");
    const r = await radr("review", "-e", "acme-audit");
    assert.match(r.out, /maint\s+parse-error/);
    assert.match(r.out, /run R-0001: partial/);
  });
});

describe("image-only and optional lanes", () => {
  const yml = (lanes: string, enforcement: string) =>
    `version: 1\nclient: acme\nslug: t\nengagement_type: due-diligence\ntier: deep\nsource: { origin: /x, sha: ${"a".repeat(40)} }\npaths: { include: ["**"], exclude: [] }\nstacks: []\nlanes: ${lanes}\nrubric: v1\nnetwork: { mode: offline, enforcement: ${enforcement} }\nllm_policy: off\nclient_licenses: []\n`;
  it("license and iac need container mode (their tools exist only in the image)", () => {
    assert.throws(() => parseEngagement(yml("[license]", "declared"), "e.yml"), (e: unknown) => e instanceof UsageError && /license run only in the toolchain image/.test(e.message));
    assert.throws(() => parseEngagement(yml("[census, iac]", "declared"), "e.yml"), UsageError);
    assert.equal(parseEngagement(yml("[license, iac]", "container"), "e.yml").lanes.length, 2);
  });

  it("scope proposes neither image-only nor optional lanes in host mode", async () => {
    const home = tmpDir();
    await seedHome(home);
    const radr = cliRunner(home);
    await radr("init", "acme", "audit");
    await radr("scope", "-e", "acme-audit", "--source", fixture.dir);
    const doc = readFileSync(layout(home, "acme-audit").engagementYml, "utf8");
    assert.match(doc, /- maint/);
    assert.doesNotMatch(doc, /- (license|iac|hygiene)\n/);
  });

  it("hygiene is optional: a broken Scorecard never makes the run partial", async () => {
    assert.equal(Matrix.load().resolve("hygiene", "tool-error", 2).action, "continue");
    const { r } = await reviewed((y) => y.replace("  - maint\n", "  - maint\n  - hygiene\n"));
    assert.match(r.out, /run R-0001: complete/, r.out);
    const home2 = tmpDir();
    await seedHome(home2);
    setFakeTool(home2, "scorecard", "echo 'not json'");
    const radr = cliRunner(home2);
    await radr("init", "acme", "audit");
    await radr("scope", "-e", "acme-audit", "--source", fixture.dir);
    const l = layout(home2, "acme-audit");
    writeFileSync(l.engagementYml, readFileSync(l.engagementYml, "utf8").replace("  - maint\n", "  - maint\n  - hygiene\n"));
    await radr("scope", "-e", "acme-audit");
    await radr("approve", "scope", "-e", "acme-audit");
    const bad = await radr("review", "-e", "acme-audit");
    assert.match(bad.out, /hygiene\s+parse-error/);
    assert.match(bad.out, /run R-0001: complete/);
  });

  it("the report shows Scorecard's offline scores when hygiene ran (W4)", async () => {
    const home = tmpDir();
    await seedHome(home);
    setFakeTool(home, "scorecard", `echo '{"checks":[{"name":"License","score":0,"reason":"no license"},{"name":"Token-Permissions","score":-1,"reason":"n/a"}]}'`);
    const radr = cliRunner(home);
    await radr("init", "acme", "audit");
    await radr("scope", "-e", "acme-audit", "--source", fixture.dir);
    const l = layout(home, "acme-audit");
    writeFileSync(l.engagementYml, readFileSync(l.engagementYml, "utf8").replace("  - maint\n", "  - maint\n  - hygiene\n"));
    await radr("scope", "-e", "acme-audit");
    await radr("approve", "scope", "-e", "acme-audit");
    await radr("review", "-e", "acme-audit");
    assert.equal((await radr("address", "-e", "acme-audit")).code, 0);
    const report = readFileSync(path.join(l.dir, "report", "report.md"), "utf8");
    assert.match(report, /# Repository hygiene/);
    assert.match(report, /\| License \| 0\/10 \|/);
    assert.match(report, /\| Token-Permissions \| not applicable \|/);
  });
});
