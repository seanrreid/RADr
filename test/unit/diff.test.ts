// M6 W2–W3: baseline, diff scope, and the diff run (AC6, AC7, AC9) with fake tools.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fixedClock } from "../../src/core/clock.js";
import { parseEngagement } from "../../src/engagement/config.js";
import { layout } from "../../src/engagement/home.js";
import { EventLog } from "../../src/state/events.js";
import { cliRunner } from "../helpers/cli.js";
import { seedHome, setFakeTool } from "../helpers/fake-toolchain.js";
import { VERIFY_RUFF, makeDiffRepo, type FixtureRepo } from "../helpers/fixture-repo.js";
import { tmpDir } from "../helpers/tmp.js";

const fixtureRoot = tmpDir();
let repo: FixtureRepo;
before(async () => { repo = await makeDiffRepo(path.join(fixtureRoot, "diff")); });

async function prReview() {
  const home = tmpDir();
  await seedHome(home);
  setFakeTool(home, "ruff", VERIFY_RUFF);
  const argsFile = path.join(tmpDir(), "gitleaks-args");
  setFakeTool(home, "gitleaks", `printf '%s\\n' "$*" > ${argsFile}; while [ $# -gt 0 ]; do if [ "$1" = "--report-path" ]; then shift; printf '[]' > "$1"; fi; shift; done`);
  const radr = cliRunner(home);
  const e = (...a: string[]) => radr(...a, "-e", "acme-pr");
  await radr("init", "acme", "pr");
  const [base = "", head = ""] = repo.commits;
  assert.equal((await e("scope", "--source", repo.dir, "--rev", base)).code, 0);
  assert.equal((await e("approve", "scope")).code, 0);
  assert.equal((await e("review")).code, 0);
  const l = layout(home, "acme-pr");
  const events = () => new EventLog(l.events, fixedClock("2026-10-08T00:00:00.000Z")).read();
  const lint = async () => (await e("findings", "--json", "--lane", "lint")).out.trim().split("\n").filter((x) => x !== "").map((x) => JSON.parse(x) as { id: string; file: string });
  return { e, l, events, lint, base, head, argsFile };
}

describe("diff tier", () => {
  it("a diff scope needs a baseline, pins its hash, and surfaces only new findings in changed files (AC6, AC7)", async () => {
    const t = await prReview();
    assert.deepEqual((await t.lint()).map((f) => f.file).sort(), ["app/a.py", "app/b.py"]);
    const noBaseline = await t.e("scope", "--rev", t.head, "--base", t.base);
    assert.equal(noBaseline.code, 2);
    assert.match(noBaseline.err, /needs a baseline: radr baseline set/);

    const b = await t.e("baseline", "set", "--from", "R-0001");
    assert.match(b.out, /baseline: 2 finding\(s\) from R-0001/);
    assert.deepEqual(t.events().filter((e) => e.type === "baseline-set").map((e) => [e.data["run_id"], e.data["findings"]]), [["R-0001", 2]]);
    assert.equal((await t.e("scope", "--rev", t.head, "--base", t.base)).code, 0);
    const yml = readFileSync(t.l.engagementYml, "utf8");
    assert.match(yml, /tier: diff/);
    assert.match(yml, new RegExp(`diff:\\n  base: ${t.base}\\n  baseline: sha256:[0-9a-f]{64}`));
    assert.equal((await t.e("approve", "scope")).code, 0);

    const r = await t.e("review");
    assert.equal(r.code, 0, r.err);
    assert.deepEqual((await t.lint()).map((f) => f.file), ["app/d.py"], "a.py is untouched, b.py's finding is baselined");
    const done = t.events().findLast((e) => e.type === "run-completed");
    assert.match(String((done?.data["notes"] as string[] | undefined)?.join(" ")), /diff: 2 finding\(s\) outside the change or already in the baseline were not surfaced/);
    assert.match(readFileSync(t.argsFile, "utf8"), new RegExp(`--log-opts=${t.base}\\.\\.${t.head}`), "secrets: the PR's commits only (AC9)");

    writeFileSync(path.join(t.l.dir, "baseline.json"), readFileSync(path.join(t.l.dir, "baseline.json"), "utf8").replace("R-0001", "R-0009"));
    const tampered = await t.e("review");
    assert.equal(tampered.code, 1);
    assert.match(tampered.err, /baseline\.json changed after the scope was approved/);
  });

  it("engagement.yml: the diff tier and the diff block come together", () => {
    const yml = (tier: string, diff: string) => `version: 1\nclient: acme\nslug: t\nengagement_type: pr-review\ntier: ${tier}\nsource: { origin: /x, sha: ${"a".repeat(40)} }\npaths: { include: ["**"], exclude: [] }\nstacks: []\nlanes: [lint]\nrubric: v2\nnetwork: { mode: offline, enforcement: declared }\nllm_policy: off\nclient_licenses: []\n${diff}`;
    const block = `diff: { base: ${"b".repeat(40)}, baseline: sha256:${"0".repeat(64)} }\n`;
    assert.equal(parseEngagement(yml("diff", block), "e.yml").diff?.base, "b".repeat(40));
    assert.throws(() => parseEngagement(yml("diff", ""), "e.yml"), /diff tier needs a diff block/);
    assert.throws(() => parseEngagement(yml("standard", block), "e.yml"), /only the diff tier/);
  });
});
