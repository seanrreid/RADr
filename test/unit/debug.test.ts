// M5 W0: debug records and the method's gates (PRD §11, invariant 7).

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixedClock } from "../../src/core/clock.js";
import { hashBytes } from "../../src/core/determinism.js";
import { bisect, nextProbe } from "../../src/debug/bisect.js";
import { guard } from "../../src/debug/guard.js";
import { promptFreeText } from "../../src/llm/prompt.js";
import { leakedRuns } from "../../src/llm/redact.js";
import { runDebugScript, type DebugSandbox } from "../../src/debug/sandbox.js";
import { gitOut } from "../../src/engagement/git.js";
import { checkoutWorktree } from "../../src/engagement/source.js";
import { RefusedError } from "../../src/core/errors.js";
import { assertCanConclude, assertCanDecide, getDebug, guardHolds, nextId, outcomeOf } from "../../src/debug/state.js";
import { layout } from "../../src/engagement/home.js";
import { EventLog } from "../../src/state/events.js";
import { cliRunner } from "../helpers/cli.js";
import { seedHome, setFakeTool } from "../helpers/fake-toolchain.js";
import { REGRESSION_BAD_INDEX, REGRESSION_COMMITS, REGRESSION_REPRO, makeFixtureRepo, makeRegressionRepo, type FixtureRepo } from "../helpers/fixture-repo.js";
import { localSandbox } from "../helpers/local-sandbox.js";
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

/** An approved engagement on the planted-regression repo, with D-0001 open and repro.sh written. */
async function opened(opts: { policy?: string; env?: Record<string, string>; issue?: string } = {}) {
  const repo = await makeRegressionRepo(path.join(tmpDir(), "calc"));
  const home = tmpDir();
  await seedHome(home);
  const radr = cliRunner(home, opts.env ?? {});
  await radr("init", "acme", "calc");
  assert.equal((await radr("scope", "-e", "acme-calc", "--source", repo.dir)).code, 0);
  if (opts.policy !== undefined) {
    const yml = layout(home, "acme-calc").engagementYml;
    writeFileSync(yml, readFileSync(yml, "utf8").replace("llm_policy: off", `llm_policy: ${opts.policy}`));
  }
  assert.equal((await radr("approve", "scope", "-e", "acme-calc")).code, 0);
  assert.equal((await radr("debug", "open", "--issue", opts.issue ?? "add(2, 2) returns 5", "-e", "acme-calc")).code, 0);
  const l = layout(home, "acme-calc");
  const script = path.join(l.debug, "D-0001", "repro", "repro.sh");
  writeFileSync(script, REGRESSION_REPRO);
  const log = new EventLog(l.events, fixedClock("2026-10-08T00:00:00.000Z"));
  const sb = (over: Partial<DebugSandbox> = {}): DebugSandbox => ({
    runtime: { name: "podman", version: "test" }, stack: "typescript-javascript", dir: ".", image: "test", install: "true",
    prelude: "", env: {}, online: false, mounts: [], runner: localSandbox, ...over,
  });
  const spec = (worktree: string, commit: string) => ({ debugId: "D-0001", kind: "repro" as const, commit, worktree, script });
  return { repo, radr, l, log, sb, spec, script, home };
}
describe("debug runs in the sandbox (M5 W1)", () => {


  it("reproduces at the bad commit, not at a good one, and records hashes that match the files", async () => {
    const t = await opened();
    const bad = t.repo.commits.at(-1) ?? "";
    const r = await runDebugScript(t.l, t.log, "consultant", t.sb(), t.spec(t.l.worktree, bad));
    assert.deepEqual([r.runId, r.exitCode, r.outcome], ["DR-0001", 1, "present"]);
    const ev = t.log.read().findLast((e) => e.type === "debug-run");
    assert.equal(ev?.data["script_hash"], hashBytes(readFileSync(t.script)));
    assert.equal(ev.data["log_hash"], hashBytes(readFileSync(path.join(t.l.dir, r.logRef))));

    const good = path.join(tmpDir(), "good");
    await checkoutWorktree(t.l.mirror, good, t.repo.commits[0] ?? "");
    const g = await runDebugScript(t.l, t.log, "consultant", t.sb(), t.spec(good, t.repo.commits[0] ?? ""));
    assert.deepEqual([g.exitCode, g.outcome], [0, "absent"]);
    assert.match((await t.radr("debug", "show", "D-0001", "-e", "acme-calc")).out, /DR-0001 {2}repro .* exit 1 → present/);
  });

  it("a failed install can't tell (skip); a sandbox that fails to run is an error", async () => {
    const t = await opened();
    const head = t.repo.commits.at(-1) ?? "";
    const skip = await runDebugScript(t.l, t.log, "consultant", t.sb({ install: "exit 3" }), t.spec(t.l.worktree, head));
    assert.deepEqual([skip.exitCode, skip.outcome], [null, "skip"]);
    const timeout: DebugSandbox["runner"] = async (req, out) => {
      const r = await localSandbox(req, out);
      return { ...r, exec: { ...r.exec, outcome: "timeout", exitCode: null } };
    };
    const err = await runDebugScript(t.l, t.log, "consultant", t.sb({ runner: timeout }), t.spec(t.l.worktree, head));
    assert.equal(err.outcome, "error");
    assert.match(String(t.log.read().findLast((e) => e.type === "debug-run")?.data["detail"]), /timed out/);
  });

  it("freezes repro.sh once it has reproduced; without a runtime or recipe the CLI refuses clearly", async () => {
    const t = await opened();
    const r = await t.radr("debug", "repro", "D-0001", "-e", "acme-calc");
    assert.equal(r.code, 1);
    assert.match(r.err, /build recipe|container runtime/);
    await runDebugScript(t.l, t.log, "consultant", t.sb(), t.spec(t.l.worktree, t.repo.commits.at(-1) ?? ""));
    writeFileSync(t.script, `${REGRESSION_REPRO}# tweaked\n`);
    const frozen = await t.radr("debug", "repro", "D-0001", "-e", "acme-calc");
    assert.equal(frozen.code, 1);
    assert.match(frozen.err, /repro\.sh changed after it reproduced the bug \(DR-0001\)/);
  });
});

describe("bisect (M5 W2)", () => {
  /** Tested commits, in order, for a bisect's runs. */
  const tested = (log: EventLog) => log.read().filter((e) => e.type === "debug-run" && e.data["kind"] === "bisect").map((e) => String(e.data["commit"]));

  async function reproduced() {
    const t = await opened();
    const r = await runDebugScript(t.l, t.log, "consultant", t.sb(), t.spec(t.l.worktree, t.repo.commits.at(-1) ?? ""));
    assert.equal(r.outcome, "present");
    return { ...t, d: () => getDebug(t.log.read(), "D-0001") };
  }

  it("nextProbe: the midpoint, else the nearest untested, unskipped index", () => {
    assert.equal(nextProbe(-1, 18, new Set()), 8);
    assert.equal(nextProbe(-1, 18, new Set([8])), 9);
    assert.equal(nextProbe(-1, 18, new Set([8, 9])), 7);
    assert.equal(nextProbe(3, 5, new Set([4])), undefined);
    assert.equal(nextProbe(3, 4, new Set()), undefined);
  });

  it("finds the planted commit in a handful of runs, records them, and cleans up its worktrees", async () => {
    const t = await reproduced();
    const r = await bisect(t.l, t.log, "consultant", t.sb(), t.d(), t.repo.commits[0] ?? "", t.script);
    assert.deepEqual(r.firstBad, [t.repo.commits[REGRESSION_BAD_INDEX]]);
    assert.ok(r.runs.length <= 7, `${String(r.runs.length)} runs`);
    assert.equal(tested(t.log)[0], t.repo.commits[0], "the good end is checked first");
    const ev = t.log.read().findLast((e) => e.type === "debug-bisected");
    assert.deepEqual(ev?.data["first_bad"], [t.repo.commits[REGRESSION_BAD_INDEX]]);
    assert.deepEqual(ev.data["runs"], r.runs.map((x) => x.runId));
    assert.equal(readdirSync(path.join(t.l.cache, "debug-worktrees")).length, 0);
    assert.doesNotMatch(await gitOut(["worktree", "list"], t.l.mirror), /debug-worktrees/);
    const show = await t.radr("debug", "show", "D-0001", "-e", "acme-calc");
    assert.match(show.out, new RegExp(`bisect: first bad ${t.repo.commits[REGRESSION_BAD_INDEX] ?? ""}`));
  });

  it("tests the same commits given the same results (determinism)", async () => {
    const [a, b] = [await reproduced(), await reproduced()];
    await bisect(a.l, a.log, "c", a.sb(), a.d(), a.repo.commits[0] ?? "", a.script);
    await bisect(b.l, b.log, "c", b.sb(), b.d(), b.repo.commits[0] ?? "", b.script);
    assert.deepEqual(tested(a.log), tested(b.log));
  });

  it("steps around skipped commits and reports a range, never a guess", async () => {
    const t = await reproduced();
    const unbuildable = new Set([t.repo.commits[REGRESSION_BAD_INDEX - 1], t.repo.commits[REGRESSION_BAD_INDEX]]);
    const runner: DebugSandbox["runner"] = (req, out) => {
      const src = req.mounts.find((m) => m.container === "/src")?.host ?? "";
      return localSandbox(unbuildable.has(path.basename(src)) ? { ...req, steps: req.steps.map((s) => (s.name === "install" ? { ...s, command: "exit 1" } : s)) } : req, out);
    };
    const r = await bisect(t.l, t.log, "consultant", t.sb({ runner }), t.d(), t.repo.commits[0] ?? "", t.script);
    assert.deepEqual(r.firstBad, t.repo.commits.slice(REGRESSION_BAD_INDEX - 1, REGRESSION_BAD_INDEX + 2));
    assert.ok(r.firstBad.includes(t.repo.commits[REGRESSION_BAD_INDEX] ?? ""));
  });

  it("refuses: before a repro, a 'good' commit that's bad, and good == bad", async () => {
    const fresh = await opened();
    await assert.rejects(bisect(fresh.l, fresh.log, "c", fresh.sb(), getDebug(fresh.log.read(), "D-0001"), fresh.repo.commits[0] ?? "", fresh.script), /hasn't been reproduced/);
    const t = await reproduced();
    await assert.rejects(bisect(t.l, t.log, "c", t.sb(), t.d(), t.repo.commits[15] ?? "", t.script), /bug is present at the "good" commit/);
    await assert.rejects(bisect(t.l, t.log, "c", t.sb(), t.d(), "HEAD", t.script), /the good commit is the bad commit/);
    assert.equal(t.log.read().filter((e) => e.type === "debug-bisected").length, 0);
  });
});

describe("hypotheses, conclusion and root-cause.md (M5 W3)", () => {
  it("walks the method end to end and writes a record that regenerates byte-identically", async () => {
    const t = await opened();
    const bad = t.repo.commits.at(-1) ?? "";
    const e = (...a: string[]) => t.radr("debug", ...a, "-e", "acme-calc");
    await runDebugScript(t.l, t.log, "c", t.sb(), t.spec(t.l.worktree, bad));
    assert.match((await e("propose", "D-0001", "add() special-cases equal operands")).out, /^H-0001 proposed for D-0001/);
    assert.equal((await e("experiment", "D-0001", "--hypothesis", "H-0009", "eq.sh")).code, 1, "unknown hypothesis");

    const eq = path.join(t.l.debug, "D-0001", "experiments", "eq.sh");
    writeFileSync(eq, `#!/bin/sh\nnode -e "process.exit(require('./src/math.js').add(3, 3) === 6 ? 0 : 1)"\n`);
    const x = await runDebugScript(t.l, t.log, "c", t.sb(), { debugId: "D-0001", kind: "experiment", commit: bad, worktree: t.l.worktree, script: eq, hypothesisId: "H-0001" });
    assert.equal(x.outcome, "present");
    assert.equal((await e("decide", "D-0001", "H-0001", "confirmed", "--run", "DR-0001", "--reason", "r")).code, 1, "a repro run isn't an experiment");
    assert.equal((await e("conclude", "D-0001", "root-caused", "--summary", "s")).code, 1, "names no confirmed hypothesis");
    const dec = await e("decide", "D-0001", "H-0001", "confirmed", "--run", x.runId, "--reason", "add(3, 3) is 7 as well");
    assert.equal(dec.code, 0, dec.err);
    await bisect(t.l, t.log, "c", t.sb(), getDebug(t.log.read(), "D-0001"), t.repo.commits[0] ?? "", t.script);
    assert.equal((await e("conclude", "D-0001", "cannot-reproduce", "--summary", "s")).code, 1, "it was reproduced");

    const c = await e("conclude", "D-0001", "root-caused", "--hypothesis", "H-0001", "--summary", "add() adds one when both operands are equal.");
    assert.equal(c.code, 0, c.err);
    assert.match(c.out, new RegExp(`introduced by ${(t.repo.commits[REGRESSION_BAD_INDEX] ?? "").slice(0, 12)}`));
    assert.equal((await e("propose", "D-0001", "another idea")).code, 1, "a concluded debug takes nothing more");

    const file = path.join(t.l.debug, "D-0001", "root-cause.md");
    const first = readFileSync(file, "utf8");
    assert.match(first, /^---\ntitle: "Root cause: D-0001"/);
    assert.match(first, /outcome: "root-caused"/);
    assert.match(first, new RegExp(`\\| Introducing commit \\| \`${t.repo.commits[REGRESSION_BAD_INDEX] ?? ""}\` \\|`));
    assert.match(first, /\| H-0001 \| confirmed \| add\(\) special-cases equal operands \| DR-0002: add\(3, 3\) is 7 as well \|/);
    assert.match(first, /# Localization\n\nBisected between/);
    writeFileSync(file, first.replace("_How the defect produces the symptom. Preserved across regeneration._", "The fast path adds a stray 1."));
    await e("report", "D-0001");
    const kept = readFileSync(file, "utf8");
    assert.match(kept, /The fast path adds a stray 1\./);
    await e("report", "D-0001");
    assert.equal(readFileSync(file, "utf8"), kept, "regeneration is byte-identical");
    assert.match((await e("list")).out, /D-0001 {2}root-caused/);
  });

  it("cannot-reproduce: allowed after attempts that never reproduced", async () => {
    const t = await opened();
    const e = (...a: string[]) => t.radr("debug", ...a, "-e", "acme-calc");
    assert.equal((await e("conclude", "D-0001", "cannot-reproduce", "--summary", "s")).code, 1, "no attempt yet");
    // An attempt at the debug's own commit that doesn't reproduce: a repro that never fails.
    writeFileSync(t.script, "#!/bin/sh\nexit 0\n");
    await runDebugScript(t.l, t.log, "c", t.sb(), t.spec(t.l.worktree, t.repo.commits.at(-1) ?? ""));
    const c = await e("conclude", "D-0001", "cannot-reproduce", "--summary", "Tried on the approved commit; add(2, 2) was 4.");
    assert.equal(c.code, 0, c.err);
    assert.match(readFileSync(path.join(t.l.debug, "D-0001", "root-cause.md"), "utf8"), /outcome: "cannot-reproduce"/);
  });
});

const TEST_PATCH = `diff --git a/test/add.test.js b/test/add.test.js
new file mode 100644
--- /dev/null
+++ b/test/add.test.js
@@ -0,0 +1,4 @@
+const { test } = require("node:test");
+const assert = require("node:assert");
+const { add } = require("../src/math.js");
+test("add(2, 2) is 4", () => assert.equal(add(2, 2), 4));
`;
const FIX_PATCH = `diff --git a/src/math.js b/src/math.js
--- a/src/math.js
+++ b/src/math.js
@@ -1,3 +1,3 @@
-const add = (a, b) => a + b + (a === b ? 1 : 0);
+const add = (a, b) => a + b;
 const mul = (a, b) => a * b;
 module.exports = { add, mul };
`;

describe("regression guard, plan item, and LLM suggestions (M5 W4)", () => {
  async function guarded(fixPatch = FIX_PATCH) {
    const t = await opened();
    await runDebugScript(t.l, t.log, "c", t.sb(), t.spec(t.l.worktree, t.repo.commits.at(-1) ?? ""));
    const dir = path.join(t.l.debug, "D-0001", "guard");
    writeFileSync(path.join(dir, "test.patch"), TEST_PATCH);
    writeFileSync(path.join(dir, "guard.sh"), "#!/bin/sh\nnode --test test/add.test.js\n");
    writeFileSync(path.join(dir, "fix.patch"), fixPatch);
    return { ...t, dir, d: () => getDebug(t.log.read(), "D-0001") };
  }

  it("holds when the test fails without the fix and passes with it; records the patches", async () => {
    const t = await guarded();
    const g = await guard(t.l, t.log, "c", t.sb(), t.d(), t.dir, undefined);
    assert.deepEqual([g.withoutFix.outcome, g.withFix.outcome, g.holds], ["present", "absent", true]);
    assert.equal(guardHolds(t.d()), true);
    const runs = t.log.read().filter((e) => e.type === "debug-run" && String(e.data["kind"]).startsWith("guard"));
    assert.deepEqual(runs.map((e) => (e.data["patch_hashes"] as string[]).length), [1, 2]);
    assert.equal(readdirSync(path.join(t.l.cache, "debug-worktrees")).length, 0);
    // A fix already in the client's history works the same way.
    const viaCommit = await guard(t.l, t.log, "c", t.sb(), t.d(), t.dir, t.repo.commits[REGRESSION_BAD_INDEX - 1]);
    assert.equal(viaCommit.holds, true);
  });

  it("does not hold when the 'fix' doesn't fix; refuses a patch that doesn't apply", async () => {
    const t = await guarded();
    const g = await guard(t.l, t.log, "c", t.sb(), t.d(), t.dir, t.repo.commits.at(-1));
    assert.deepEqual([g.withFix.outcome, g.holds], ["present", false]);
    assert.equal(guardHolds(t.d()), false);
    const broken = await guarded(FIX_PATCH.replace("a + b + (a === b ? 1 : 0)", "something else entirely"));
    await assert.rejects(guard(broken.l, broken.log, "c", broken.sb(), broken.d(), broken.dir, undefined), /fix\.patch does not apply/);
  });

  it("a root-caused debug concluded --to-plan becomes a re-runnable remediation item", async () => {
    const t = await guarded();
    const e = (...a: string[]) => t.radr(...a, "-e", "acme-calc");
    assert.equal((await e("review")).code, 0);
    await e("debug", "propose", "D-0001", "add() special-cases equal operands");
    const eq = path.join(t.l.debug, "D-0001", "experiments", "eq.sh");
    writeFileSync(eq, `#!/bin/sh\nnode -e "process.exit(require('./src/math.js').add(3, 3) === 6 ? 0 : 1)"\n`);
    const x = await runDebugScript(t.l, t.log, "c", t.sb(), { debugId: "D-0001", kind: "experiment", commit: t.repo.commits.at(-1) ?? "", worktree: t.l.worktree, script: eq, hypothesisId: "H-0001" });
    await e("debug", "decide", "D-0001", "H-0001", "confirmed", "--run", x.runId, "--reason", "r");
    assert.equal((await e("debug", "conclude", "D-0001", "root-caused", "--hypothesis", "H-0001", "--summary", "add() adds one for equal operands.", "--to-plan")).code, 0);
    await guard(t.l, t.log, "c", t.sb(), getDebug(t.log.read(), "D-0001"), t.dir, undefined);
    assert.equal((await e("address")).code, 0);
    const plan = readFileSync(path.join(t.l.dir, "plan", "remediation.md"), "utf8");
    assert.match(plan, /## Debug fixes\n\n### D-0001 add\(\) adds one for equal operands\./);
    assert.match(plan, /\| unknown \| holds \|/, "no bisect ran, so the introducing commit is unknown");
    assert.match(plan, /\*\*Done when:\*\* the regression guard/);
    await e("debug", "report", "D-0001");
    assert.match(readFileSync(path.join(t.l.debug, "D-0001", "root-cause.md"), "utf8"), /# Regression guard\n\n\| Run \| Kind[^\n]*\n[^\n]*\n\| DR-0003 \| guard-without-fix .* present \|\n\| DR-0004 \| guard-with-fix .* absent \|/);
  });

  it("suggest: LLM hypotheses are labelled proposals; policy off never spawns; metadata-only withholds code", async () => {
    const script = tmpDir("radr-agent-script-");
    const agentDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../helpers/fake-agent.js");
    const reply = JSON.stringify({ hypotheses: [{ text: "add() has a fast path for equal operands", experiment: "compare add(3,3) with 6" }, { text: "", experiment: "x" }] });
    for (let i = 1; i <= 3; i++) writeFileSync(path.join(script, `response-${String(i)}`), reply);
    const env = { RADR_AGENT_CMD: JSON.stringify([process.execPath, agentDir, script]) };

    const off = await opened({ env });
    assert.equal((await off.radr("debug", "suggest", "D-0001", "-e", "acme-calc")).code, 1);
    assert.equal(existsSync(path.join(script, "count")), false, "policy off: the agent never ran");

    const t = await opened({ env, policy: "metadata-only", issue: "add returns a + b + (a === b ? 1 : 0) for equal inputs" });
    await runDebugScript(t.l, t.log, "c", t.sb(), t.spec(t.l.worktree, t.repo.commits.at(-1) ?? ""));
    const s = await t.radr("debug", "suggest", "D-0001", "-e", "acme-calc");
    assert.equal(s.code, 0, s.err);
    assert.match(s.out, /proposed H-0001; rejected 1/);
    const prompt = readFileSync(path.join(t.l.llm, "L-0001.prompt.txt"), "utf8");
    assert.match(prompt, /withheld: quotes repository code/);
    assert.doesNotMatch(prompt, /first_bad_diff|repro_log_tail/);
    assert.deepEqual(leakedRuns(promptFreeText(prompt), t.l.worktree), []);
    assert.match((await t.radr("debug", "show", "D-0001", "-e", "acme-calc")).out, /H-0001 {2}proposed {2}\[LLM\] add\(\) has a fast path/);
    assert.equal((await t.radr("debug", "decide", "D-0001", "H-0001", "confirmed", "--run", "DR-0001", "--reason", "the model said so", "-e", "acme-calc")).code, 1, "only an experiment decides");
  });
});
