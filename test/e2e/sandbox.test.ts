// M2 sandbox end-to-end (AC7–AC9) with a REAL container runtime and the real toolchain:
// scope proposes a recipe → deps warm (network) → re-scope pins the cache → approve →
// review runs types + coverage OFFLINE in the sandbox.
//
// Needs RADR_E2E_TOOLS (a RADR_HOME with `radr tools install` done, images pulled) and
// RADR_E2E_SANDBOX=1 (Podman or Docker reachable, network for the warm). Skipped otherwise.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../../src/core/exec.js";
import { makeSandboxFixtureRepo, type FixtureRepo } from "../helpers/fixture-repo.js";
import { tmpDir } from "../helpers/tmp.js";
import { zipStored } from "../helpers/zip.js";
import { syncOsv } from "../../src/toolchain/db.js";
import { fixedClock } from "../../src/core/clock.js";

const TOOLS_HOME = process.env["RADR_E2E_TOOLS"];
const ENABLED = TOOLS_HOME !== undefined && process.env["RADR_E2E_SANDBOX"] === "1";
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../bin/radr.js");
const PASS = ["PATH", "HOME", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "CONTAINER_HOST", "CONTAINER_CONNECTION", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"];

describe("M2 sandbox end-to-end (real runtime)", { skip: ENABLED ? false : "set RADR_E2E_TOOLS and RADR_E2E_SANDBOX=1" }, () => {
  const root = tmpDir("radr-e2e-sbx-");
  let fixture: FixtureRepo;
  let home: string;
  before(async () => {
    fixture = await makeSandboxFixtureRepo(path.join(root, "fork"));
    home = path.join(root, "home");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(home);
    symlinkSync(path.join(TOOLS_HOME ?? "", "tools"), path.join(home, "tools"));
    // Offline OSV snapshot from the vendored advisories (db sync would need the network).
    const osv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../test/fixtures/osv");
    await syncOsv(home, fixedClock("2026-10-01T00:00:00Z"), (url) => Promise.resolve(zipStored(url.includes("/npm/")
      ? { "GHSA-35jh-r3h4-6jhm.json": readFileSync(path.join(osv, "GHSA-35jh-r3h4-6jhm.json")) }
      : { "PYSEC-2018-28.json": readFileSync(path.join(osv, "PYSEC-2018-28.json")) })));
  });

  const radr = async (...args: string[]) => {
    const env: Record<string, string> = { RADR_HOME: home, RADR_ACTOR: "e2e@example.com" };
    for (const k of PASS) { const v = process.env[k]; if (v !== undefined) env[k] = v; }
    const r = await run({ command: process.execPath, args: [bin, ...args], cwd: root, env, timeoutMs: 20 * 60 * 1000, okExitCodes: [0, 1, 2, 3] });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };

  it("types + coverage run offline in the sandbox and are stable", async () => {
    const step = async (...args: string[]) => {
      const r = await radr(...args);
      assert.equal(r.code, 0, `radr ${args.join(" ")}:\n${r.out}\n${r.err}`);
      return r.out;
    };
    await step("init", "acme", "sbx");
    const first = await step("scope", "-e", "acme-sbx", "--source", fixture.dir);
    assert.match(first, /warning: no dependency snapshot/);
    const yml = readFileSync(path.join(home, "engagements", "acme-sbx", "engagement.yml"), "utf8");
    assert.match(yml, /- types\n {2}- coverage/);
    assert.match(yml, /test: npm test/);
    await step("deps", "warm", "-e", "acme-sbx");
    assert.doesNotMatch(await step("scope", "-e", "acme-sbx"), /no dependency snapshot/);
    await step("approve", "scope", "-e", "acme-sbx");
    const review = await step("review", "-e", "acme-sbx");
    assert.match(review, /types\s+success/);
    assert.match(review, /coverage\s+success/);

    const findings = (await step("findings", "-e", "acme-sbx", "--json")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.ok(findings.some((f) => f["tool"] === "tsc" && f["rule_id"] === "TS2322" && f["file"] === "src/math.ts"));
    assert.ok(findings.some((f) => f["tool"] === "mypy" && f["rule_id"] === "return-value" && f["file"] === "app/calc.py"));
    assert.ok(!findings.some((f) => f["tool"] === "radr-build"), "the fixture builds offline from the cache");

    const runId = /run (R-\d{4})/.exec(review)?.[1] ?? "";
    const cov = JSON.parse(readFileSync(path.join(home, "engagements", "acme-sbx", "metrics", runId, "coverage.json"), "utf8")) as { stacks: Record<string, { status: string; line_pct: number | null }> };
    const js = cov.stacks["typescript-javascript"];
    const py = cov.stacks["python"];
    assert.ok(js && py, "coverage metrics for both stacks");
    assert.equal(js.status, "stable");
    assert.equal(py.status, "stable");
    assert.ok(py.line_pct !== null && py.line_pct > 50);
  });
});
