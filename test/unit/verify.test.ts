// M6 W0: radr verify (AC1–AC3) with fake tools whose output depends on the commit.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fixedClock } from "../../src/core/clock.js";
import { layout } from "../../src/engagement/home.js";
import { checkTransition } from "../../src/findings/disposition.js";
import { EventLog } from "../../src/state/events.js";
import { scopeDifference } from "../../src/verify/verify.js";
import type { ScopeSnapshot } from "../../src/review/run.js";
import { cliRunner } from "../helpers/cli.js";
import { seedHome, setFakeTool } from "../helpers/fake-toolchain.js";
import { VERIFY_RUFF, makeVerifyRepo, type FixtureRepo } from "../helpers/fixture-repo.js";
import { tmpDir } from "../helpers/tmp.js";

// Module level, not inside before(): tmpDir's cleanup hook would fire before the tests run.
const fixtureRoot = tmpDir();
let repo: FixtureRepo;
before(async () => { repo = await makeVerifyRepo(path.join(fixtureRoot, "verify")); });

async function engagement() {
  const home = tmpDir();
  await seedHome(home);
  setFakeTool(home, "ruff", VERIFY_RUFF);
  const radr = cliRunner(home);
  const e = (...a: string[]) => radr(...a, "-e", "acme-v");
  await radr("init", "acme", "v");
  const at = async (i: number) => {
    const sc = await e("scope", "--source", repo.dir, "--rev", repo.commits[i] ?? "");
    assert.equal(sc.code, 0, sc.err);
    assert.equal((await e("approve", "scope")).code, 0);
  };
  const l = layout(home, "acme-v");
  const events = () => new EventLog(l.events, fixedClock("2026-10-08T00:00:00.000Z")).read();
  const lint = async () => (await e("findings", "--json", "--lane", "lint")).out.trim().split("\n").filter((x) => x !== "")
    .map((x) => JSON.parse(x) as { id: string; file: string; state: string });
  return { radr, e, at, l, events, lint, home };
}

describe("radr verify", () => {
  it("fixed → verified when its lane ran clean; kept stays confirmed; a reintroduced one regresses (AC2)", async () => {
    const t = await engagement();
    await t.at(0);
    const r1 = await t.e("review");
    assert.equal(r1.code, 0, r1.err);
    const initial = await t.lint();
    assert.deepEqual(initial.map((f) => f.file).sort(), ["app/a.py", "app/b.py", "app/c.py"]);
    const id = (file: string) => initial.find((f) => f.file === file)?.id ?? "";
    for (const f of initial) await t.e("disposition", f.id, "confirmed");

    await t.at(1);
    const v1 = await t.e("verify", "--against", "R-0001");
    assert.equal(v1.code, 0, v1.err);
    const ac = [id("app/a.py"), id("app/c.py")].sort();
    assert.match(v1.out, new RegExp(`fixed 2: ${ac.join(", ")}`));
    assert.match(v1.out, new RegExp(`verified 2: ${ac.join(", ")}`));
    assert.match(v1.out, new RegExp(`still present 1: ${id("app/b.py")}`));
    const actors = t.events().filter((e) => e.type === "finding-disposition" && e.actor.startsWith("verify@")).map((e) => [e.data["finding_id"], e.data["to"], e.actor]);
    assert.deepEqual(actors, ac.flatMap((x) => [[x, "fixed", "verify@R-0002"], [x, "verified", "verify@R-0002"]]));

    await t.at(2);
    const v2 = await t.e("verify", "--against", "R-0002");
    assert.equal(v2.code, 0, v2.err);
    assert.match(v2.out, new RegExp(`regressed 1: ${id("app/c.py")}`), "same fingerprint, so the same finding id comes back");
    const states = Object.fromEntries((await t.lint()).map((f) => [f.file, f.state]));
    assert.deepEqual(states, { "app/b.py": "confirmed", "app/c.py": "regressed" });
    const done = t.events().filter((e) => e.type === "verify-completed").map((e) => [e.data["against"], e.data["run_id"], e.data["fixed"], e.data["verified"], e.data["regressed"]]);
    assert.deepEqual(done, [["R-0001", "R-0002", 2, 2, 0], ["R-0002", "R-0003", 0, 0, 1]]);
    // The consultant re-confirms a regression for the next cycle.
    assert.equal((await t.e("disposition", id("app/c.py"), "confirmed")).code, 0);
  });

  it("the report gains a Verification section and the plan says what closed (AC5)", async () => {
    const t = await engagement();
    await t.at(0);
    await t.e("review");
    const initial = await t.lint();
    for (const f of initial) await t.e("disposition", f.id, "confirmed");
    await t.at(1);
    await t.e("verify", "--against", "R-0001");
    assert.equal((await t.e("address")).code, 0);
    const report = readFileSync(path.join(t.l.dir, "report", "report.md"), "utf8");
    assert.match(report, /# Verification\n\nThis run re-checked the findings of R-0001 at commit `[0-9a-f]{40}`/);
    assert.match(report, /\| verified \| 2 \|\n\| fixed \(not verified\) \| 0 \|\n\| regressed \| 0 \|\n\| still present \| 1 \|/);
    const a = initial.find((f) => f.file === "app/a.py")?.id ?? "";
    assert.match(report, new RegExp(`\\| ${a} \\| [a-z]+ \\| verified \\| \`ruff/F401\` \\| \`app/a\\.py:1\` \\|`));
    const plan = readFileSync(path.join(t.l.dir, "plan", "remediation.md"), "utf8");
    assert.match(plan, /# Remediation plan\n\nVerified against R-0001 at `[0-9a-f]{12}`: 2 verified, 0 regressed\. This plan lists only what is still open\./);
  });

  it("judgment findings close by hand (fixed, with a reason); tool findings only via verify (AC4)", () => {
    assert.doesNotThrow(() => { checkTransition("confirmed", "fixed", "checked the handler at 3f2a", "J-0001"); });
    assert.throws(() => { checkTransition("confirmed", "fixed", undefined, "J-0001"); }, /requires --reason/);
    assert.throws(() => { checkTransition("confirmed", "fixed", "r", "F-0001"); }, /can't be set by hand/);
    assert.throws(() => { checkTransition("pending", "fixed", "r", "J-0001"); }, /illegal transition/);
  });

  it("a lane that didn't run clean can't vouch: absent findings stay fixed, not verified (AC3)", async () => {
    const t = await engagement();
    await t.at(0);
    await t.e("review");
    for (const f of await t.lint()) await t.e("disposition", f.id, "confirmed");
    await t.at(3);
    const v = await t.e("verify", "--against", "R-0001");
    assert.equal(v.code, 0, v.err);
    assert.match(v.out, /fixed 3/);
    assert.match(v.out, /verified 0/);
    assert.match(v.out, /the run was partial/);
  });

  it("refuses: a scope that changed beyond the commit, the same commit, a run without a snapshot (AC1)", async () => {
    const t = await engagement();
    await t.at(0);
    await t.e("review");
    const same = await t.e("verify", "--against", "R-0001");
    assert.equal(same.code, 1);
    assert.match(same.err, /same commit/);

    assert.equal((await t.e("scope", "--source", repo.dir, "--rev", repo.commits[1] ?? "")).code, 0);
    writeFileSync(t.l.engagementYml, readFileSync(t.l.engagementYml, "utf8").replace("rubric: v2", "rubric: v1"));
    await t.e("approve", "scope");
    const changed = await t.e("verify", "--against", "R-0001");
    assert.equal(changed.code, 1);
    assert.match(changed.err, /changed beyond the commit: engagement\.yml \(other than the commit\)/);
    assert.equal(t.events().filter((e) => e.type === "run-started").length, 1, "nothing ran");

    rmSync(path.join(t.l.raw, "R-0001", "scope.json"));
    assert.match((await t.e("verify", "--against", "R-0001")).err, /predates radr verify/);
  });

  it("scopeDifference ignores the commit and the dependency snapshot only", () => {
    const base = (sha: string, deps: string, osv: string): ScopeSnapshot => ({
      engagement: { source: { origin: "/x", sha } } as unknown as ScopeSnapshot["engagement"],
      toolchain_lock: { tools: {} }, snapshots_lock: { osv: { id: osv }, deps: { id: deps } },
    });
    assert.equal(scopeDifference(base("a".repeat(40), "d1", "o1"), base("b".repeat(40), "d2", "o1")), null);
    assert.match(scopeDifference(base("a".repeat(40), "d1", "o1"), base("b".repeat(40), "d1", "o2")) ?? "", /vulnerability snapshots/);
  });
});
