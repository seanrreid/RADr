// Runner behavior (T4.1, AC6, AC9, AC12, AC16) with fake tools, so every lane outcome can be
// forced deterministically without the real binaries.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { layout } from "../../src/engagement/home.js";
import { EventLog } from "../../src/state/events.js";
import { fixedClock } from "../../src/core/clock.js";
import { loadManifest, currentPlatform } from "../../src/toolchain/manifest.js";
import { toolDir } from "../../src/toolchain/install.js";
import { cliRunner } from "../helpers/cli.js";
import { seedHome, setFakeTool, tamperFakeTool } from "../helpers/fake-toolchain.js";
import { makeFixtureRepo, type FixtureRepo } from "../helpers/fixture-repo.js";
import { tmpDir } from "../helpers/tmp.js";

const fixtureRoot = tmpDir();
let fixture: FixtureRepo;
before(async () => { fixture = await makeFixtureRepo(path.join(fixtureRoot, "fork")); });

async function approvedEngagement(extraEnv: Record<string, string> = {}) {
  const home = tmpDir();
  await seedHome(home);
  const radr = cliRunner(home, extraEnv);
  await radr("init", "acme", "audit");
  const s = await radr("scope", "-e", "acme-audit", "--source", fixture.dir);
  assert.equal(s.code, 0, s.err);
  const a = await radr("approve", "scope", "-e", "acme-audit");
  assert.equal(a.code, 0, a.err);
  const l = layout(home, "acme-audit");
  const events = () => new EventLog(l.events, fixedClock("2026-01-01T00:00:00Z")).read();
  return { home, radr, l, events };
}

const laneEvents = (events: ReturnType<typeof EventLog.prototype.read>, lane: string) =>
  events.filter((e) => e.type === "lane-completed" && e.data["lane"] === lane);

describe("radr review", () => {
  it("runs every lane in order, stores raw output, and records the run (AC12)", async () => {
    const { radr, l, events } = await approvedEngagement();
    const r = await radr("review", "-e", "acme-audit");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /run R-0001: complete/);
    const types = events().map((e) => e.type).filter((t) => t.startsWith("run-") || t.startsWith("lane-"));
    const perLane = ["lane-started", "lane-completed"];
    assert.deepEqual(types, ["run-started", ...perLane, ...perLane, ...perLane, ...perLane, "run-completed"]);
    for (const e of events().filter((x) => x.type === "lane-completed")) {
      const tools = e.data["tools"] as { raw_ref?: string }[];
      for (const t of tools) if (t.raw_ref !== undefined) assert.ok(existsSync(path.join(l.dir, t.raw_ref)), `missing raw ${t.raw_ref}`);
    }
    assert.ok(existsSync(path.join(l.raw, "R-0001", "census.attempt-1", "scc.json")));
  });

  it("refuses to run without an approved scope, or after the scope changed (gate)", async () => {
    const home = tmpDir();
    await seedHome(home);
    const radr = cliRunner(home);
    await radr("init", "acme", "audit");
    await radr("scope", "-e", "acme-audit", "--source", fixture.dir);
    const unapproved = await radr("review", "-e", "acme-audit");
    assert.equal(unapproved.code, 1);
    assert.match(unapproved.err, /radr approve scope/);

    await radr("approve", "scope", "-e", "acme-audit");
    const l = layout(home, "acme-audit");
    writeFileSync(l.engagementYml, readFileSync(l.engagementYml, "utf8").replace("tier: standard", "tier: deep"));
    const changed = await radr("review", "-e", "acme-audit");
    assert.equal(changed.code, 1);
    assert.match(changed.err, /scope changed since approval/);
  });

  it("re-checks the scope before EVERY lane and aborts the run if it moved (AC9)", async () => {
    const { home, radr, events } = await approvedEngagement();
    // census edits the scope mid-run (the worktree is <engagement>/source/worktree).
    setFakeTool(home, "scc", "sed -i.bak 's/tier: standard/tier: deep/' ../../engagement.yml; echo '[]'");
    // …which is itself a drift of the census tool, so re-lock first by re-scoping and re-approving.
    await radr("scope", "-e", "acme-audit");
    await radr("approve", "scope", "-e", "acme-audit");
    const r = await radr("review", "-e", "acme-audit");
    assert.equal(r.code, 1);
    assert.match(r.err, /scope changed since approval/);
    const completed = events().filter((e) => e.type === "run-completed");
    assert.equal(completed.at(-1)?.data["status"], "aborted");
    assert.equal(laneEvents(events(), "lint").length, 0, "lint must not run after the scope moved");
  });

  it("retries a tool error up to max_attempts, then marks the lane partial (matrix)", async () => {
    const { home, radr, events } = await approvedEngagement();
    setFakeTool(home, "ruff", "echo boom >&2; exit 3");
    await radr("scope", "-e", "acme-audit");
    await radr("approve", "scope", "-e", "acme-audit");
    const r = await radr("review", "-e", "acme-audit");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /run R-0001: partial/);
    const lint = laneEvents(events(), "lint");
    assert.deepEqual(lint.map((e) => [e.data["attempt"], e.data["outcome"], e.data["action"]]), [[1, "tool-error", "retry"], [2, "tool-error", "partial"]]);
  });

  it("marks unparseable output as parse-error (partial), keeping the raw evidence", async () => {
    const { home, radr, events, l } = await approvedEngagement();
    setFakeTool(home, "scc", "echo 'not json'");
    await radr("scope", "-e", "acme-audit");
    await radr("approve", "scope", "-e", "acme-audit");
    const r = await radr("review", "-e", "acme-audit");
    assert.match(r.out, /census\s+parse-error\s+partial/);
    assert.equal(readFileSync(path.join(l.raw, "R-0001", "census.attempt-1", "scc.json"), "utf8"), "not json\n");
    assert.equal(events().findLast((e) => e.type === "run-completed")?.data["status"], "partial");
  });

  it("aborts on a binary that changed after scoping (version-drift) and on a missing tool", async () => {
    const drifted = await approvedEngagement();
    tamperFakeTool(drifted.home, "gitleaks", "echo '[]'");
    const r1 = await drifted.radr("review", "-e", "acme-audit");
    assert.equal(r1.code, 1);
    assert.match(r1.out, /secrets\s+version-drift\s+abort/);
    assert.equal(laneEvents(drifted.events(), "sca").length, 0, "no lane runs after an abort");

    const missing = await approvedEngagement();
    const entry = loadManifest().tools["osv-scanner"];
    assert.ok(entry);
    rmSync(path.join(toolDir(missing.home, "osv-scanner", entry.version), entry.platforms[currentPlatform()].bin));
    const r2 = await missing.radr("review", "-e", "acme-audit");
    assert.equal(r2.code, 1);
    assert.match(r2.out, /sca\s+tool-missing\s+abort/);
  });

  it("never invokes RADR_AGENT_CMD under llm_policy off (AC16)", async () => {
    const trapDir = tmpDir();
    const sentinel = path.join(trapDir, "agent-was-called");
    const trap = path.join(trapDir, "trap.sh");
    writeFileSync(trap, `#!/bin/sh\ntouch ${sentinel}\n`, { mode: 0o755 });
    const { radr } = await approvedEngagement({ RADR_AGENT_CMD: trap });
    assert.equal((await radr("review", "-e", "acme-audit")).code, 0);
    await radr("findings", "-e", "acme-audit");
    await radr("status", "-e", "acme-audit");
    assert.equal(existsSync(sentinel), false, "the agent command must never run when llm_policy is off");
  });
});
