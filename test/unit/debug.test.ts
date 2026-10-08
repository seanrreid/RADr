// M5 W0: debug records and the method's gates (PRD §11, invariant 7).

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fixedClock } from "../../src/core/clock.js";
import { RefusedError } from "../../src/core/errors.js";
import { assertCanConclude, assertCanDecide, getDebug, nextId, outcomeOf } from "../../src/debug/state.js";
import { layout } from "../../src/engagement/home.js";
import { EventLog } from "../../src/state/events.js";
import { cliRunner } from "../helpers/cli.js";
import { seedHome, setFakeTool } from "../helpers/fake-toolchain.js";
import { REGRESSION_BAD_INDEX, REGRESSION_COMMITS, makeFixtureRepo, makeRegressionRepo, type FixtureRepo } from "../helpers/fixture-repo.js";
import { tmpDir } from "../helpers/tmp.js";

const fixtureRoot = tmpDir();
let fixture: FixtureRepo;
before(async () => { fixture = await makeFixtureRepo(path.join(fixtureRoot, "fork")); });

const SHA = "a".repeat(40);
const H = "sha256:" + "0".repeat(64);

/** A bare event log with one open debug, for driving the gates directly. */
function logWithDebug() {
  const log = new EventLog(path.join(tmpDir(), "events.jsonl"), fixedClock("2026-10-08T00:00:00.000Z"));
  log.append("debug-opened", "consultant", { debug_id: "D-0001", from: "issue", symptom: "add(2,2) is 5", commit: SHA });
  const run = (runId: string, kind: string, exit: number, hypothesis?: string) =>
    log.append("debug-run", "consultant", {
      debug_id: "D-0001", run_id: runId, kind, commit: SHA, script_hash: H, exit_code: exit, outcome: outcomeOf(exit),
      log_ref: `debug/D-0001/runs/${runId}.log`, log_hash: H, ...(hypothesis === undefined ? {} : { hypothesis_id: hypothesis }),
    });
  const propose = (id: string) => log.append("hypothesis-proposed", "consultant", { debug_id: "D-0001", hypothesis_id: id, text: "add special-cases equal operands", source: "consultant" });
  const decide = (id: string, to: string, runId: string) => log.append("hypothesis-decided", "consultant", { debug_id: "D-0001", hypothesis_id: id, to, run_id: runId, reason: "r" });
  const d = () => getDebug(log.read(), "D-0001");
  return { log, run, propose, decide, d };
}

describe("the repro contract (git bisect run)", () => {
  it("maps exit codes: 0 absent, 125 skip, other non-zero present, none error", () => {
    assert.deepEqual([0, 1, 125, 126, 127, 2].map(outcomeOf), ["absent", "present", "skip", "present", "present", "present"]);
    assert.equal(outcomeOf(null), "error");
  });
});

describe("debug gates (invariant 7)", () => {
  it("root-caused needs a reproducing repro AND a confirmed hypothesis", () => {
    const t = logWithDebug();
    assert.throws(() => { assertCanConclude(t.d(), "root-caused", undefined); }, /needs a recorded run that reproduces/);
    t.run("DR-0001", "repro", 0);
    assert.throws(() => { assertCanConclude(t.d(), "root-caused", undefined); }, /needs a recorded run that reproduces/, "an exit-0 repro didn't reproduce");
    t.run("DR-0002", "repro", 1);
    assert.throws(() => { assertCanConclude(t.d(), "root-caused", undefined); }, /names the confirmed hypothesis/);
    t.propose("H-0001");
    assert.throws(() => { assertCanConclude(t.d(), "root-caused", "H-0001"); }, /not a confirmed hypothesis/);
    t.run("DR-0003", "experiment", 1, "H-0001");
    assert.doesNotThrow(() => { assertCanDecide(t.d(), "H-0001", "confirmed", "DR-0003"); });
    t.decide("H-0001", "confirmed", "DR-0003");
    assert.doesNotThrow(() => { assertCanConclude(t.d(), "root-caused", "H-0001"); });
  });

  it("only an experiment recorded against the hypothesis decides it, and confirmation waits for a repro", () => {
    const t = logWithDebug();
    t.propose("H-0001");
    t.propose("H-0002");
    t.run("DR-0001", "experiment", 1, "H-0002");
    t.run("DR-0002", "experiment", 1, "H-0001");
    t.run("DR-0003", "experiment", 125, "H-0001");
    assert.throws(() => { assertCanDecide(t.d(), "H-0001", "confirmed", "DR-0001"); }, /not an experiment recorded against H-0001/);
    assert.throws(() => { assertCanDecide(t.d(), "H-0001", "confirmed", "DR-0002"); }, /before the bug is reproduced/);
    assert.doesNotThrow(() => { assertCanDecide(t.d(), "H-0001", "refuted", "DR-0002"); }, "refuting needs no repro");
    assert.throws(() => { assertCanDecide(t.d(), "H-0001", "refuted", "DR-0003"); }, /ended skip/);
    t.run("DR-0004", "repro", 1);
    assert.throws(() => { assertCanDecide(t.d(), "H-0001", "confirmed", "DR-0004"); }, /not an experiment/, "a repro run isn't an experiment");
    t.decide("H-0001", "refuted", "DR-0002");
    assert.throws(() => { assertCanDecide(t.d(), "H-0001", "confirmed", "DR-0002"); }, /already refuted/);
  });

  it("cannot-reproduce needs an attempt and no reproducing run; a concluded debug takes no decisions", () => {
    const t = logWithDebug();
    assert.throws(() => { assertCanConclude(t.d(), "cannot-reproduce", undefined); }, /at least one recorded repro attempt/);
    t.run("DR-0001", "repro", 0);
    assert.doesNotThrow(() => { assertCanConclude(t.d(), "cannot-reproduce", undefined); });
    t.run("DR-0002", "repro", 1);
    assert.throws(() => { assertCanConclude(t.d(), "cannot-reproduce", undefined); }, /was reproduced/);
    t.log.append("debug-concluded", "consultant", { debug_id: "D-0001", outcome: "cannot-reproduce", summary: "s" });
    t.propose("H-0001");
    assert.throws(() => { assertCanDecide(t.d(), "H-0001", "refuted", "DR-0001"); }, RefusedError);
    assert.throws(() => { assertCanConclude(t.d(), "root-caused", "H-0001"); }, /is concluded/);
  });

  it("numbers debugs, runs and hypotheses across the engagement", () => {
    const t = logWithDebug();
    t.run("DR-0001", "repro", 1);
    assert.deepEqual([nextId(t.log.read(), "D"), nextId(t.log.read(), "DR"), nextId(t.log.read(), "H")], ["D-0002", "DR-0002", "H-0001"]);
  });
});

describe("radr debug open / list / show", () => {
  async function approved(edit?: (yml: string) => string, tools?: (home: string) => void) {
    const home = tmpDir();
    await seedHome(home);
    tools?.(home); // before scope: scoping pins the tool binaries
    const radr = cliRunner(home);
    await radr("init", "acme", "audit");
    await radr("scope", "-e", "acme-audit", "--source", fixture.dir);
    const l = layout(home, "acme-audit");
    if (edit !== undefined) writeFileSync(l.engagementYml, edit(readFileSync(l.engagementYml, "utf8")));
    return { radr, l, home };
  }

  it("refuses without an approved scope; opens from an issue; lists and shows it", async () => {
    const { radr, l } = await approved();
    const refused = await radr("debug", "open", "--issue", "login fails", "-e", "acme-audit");
    assert.equal(refused.code, 1);
    assert.equal((await radr("approve", "scope", "-e", "acme-audit")).code, 0);
    assert.equal((await radr("debug", "open", "-e", "acme-audit")).code, 2, "needs --issue or --from-finding");
    const o = await radr("debug", "open", "--issue", "login fails after 3 tries", "--expected", "a lockout message", "-e", "acme-audit");
    assert.equal(o.code, 0, o.err);
    assert.match(o.out, /^opened D-0001 at [0-9a-f]{12}: login fails after 3 tries/);
    for (const d of ["repro", "experiments", "guard", "runs"]) assert.ok(existsSync(path.join(l.debug, "D-0001", d)));
    assert.match((await radr("debug", "list", "-e", "acme-audit")).out, /D-0001 {2}intake {11}login fails/);
    const show = await radr("debug", "show", "D-0001", "-e", "acme-audit");
    assert.match(show.out, /expected: a lockout message/);
    assert.equal((await radr("debug", "show", "D-0009", "-e", "acme-audit")).code, 1);
  });

  it("opens from a finding, quoting it as the symptom", async () => {
    const { radr } = await approved(undefined, (home) => {
      setFakeTool(home, "ruff", `P=$(pwd -P); printf '[{"filename":"%s/app/main.py","code":"F401","message":"unused import","location":{"row":1},"end_location":{"row":1}}]' "$P"`);
    });
    await radr("approve", "scope", "-e", "acme-audit");
    await radr("review", "-e", "acme-audit");
    assert.equal((await radr("debug", "open", "--from-finding", "F-9999", "-e", "acme-audit")).code, 2);
    const o = await radr("debug", "open", "--from-finding", "F-0001", "-e", "acme-audit");
    assert.equal(o.code, 0, o.err);
    assert.match(o.out, /opened D-0001 at [0-9a-f]{12}: F-0001 /);
  });

  it("a standalone debug engagement has no lanes: review refuses, debug works", async () => {
    const { radr } = await approved((y) => y.replace(/engagement_type: [a-z-]+/, "engagement_type: debug").replace(/lanes:\n( {2}- [a-z]+\n)+/, "lanes: []\n"));
    assert.equal((await radr("approve", "scope", "-e", "acme-audit")).code, 0);
    const r = await radr("review", "-e", "acme-audit");
    assert.equal(r.code, 1);
    assert.match(r.err, /no lanes \(a standalone debug engagement\)/);
    assert.equal((await radr("debug", "open", "--issue", "x", "-e", "acme-audit")).code, 0);
    const { radr: other } = await approved((y) => y.replace(/lanes:\n( {2}- [a-z]+\n)+/, "lanes: []\n"));
    assert.match((await other("approve", "scope", "-e", "acme-audit")).err, /only a debug engagement may have no lanes/);
  });
});

describe("the planted-regression fixture", () => {
  it("is deterministic and breaks add() at commit 13", async () => {
    const [a, b] = await Promise.all([makeRegressionRepo(path.join(tmpDir(), "r")), makeRegressionRepo(path.join(tmpDir(), "r"))]);
    assert.equal(a.commits.length, REGRESSION_COMMITS);
    assert.deepEqual(a.commits, b.commits);
    assert.match(readFileSync(path.join(a.dir, "src/math.js"), "utf8"), /a === b \? 1 : 0/);
    assert.equal(a.commits.length - REGRESSION_BAD_INDEX, 8, "eight bad commits, twelve good");
  });
});
