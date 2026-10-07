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
import { makeFixtureRepo, makeHealthFixtureRepo, makeSandboxFixtureRepo, type FixtureRepo } from "../helpers/fixture-repo.js";
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

describe("M3 container toolchain end-to-end (real runtime)", { skip: ENABLED ? false : "set RADR_E2E_TOOLS and RADR_E2E_SANDBOX=1" }, () => {
  const root = tmpDir("radr-e2e-ctr-");
  let fixture: FixtureRepo;
  let home: string;
  before(async () => {
    fixture = await makeFixtureRepo(path.join(root, "fork"));
    home = path.join(root, "home");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(home);
    symlinkSync(path.join(TOOLS_HOME ?? "", "tools"), path.join(home, "tools"));
    const osv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../test/fixtures/osv");
    await syncOsv(home, fixedClock("2026-10-01T00:00:00Z"), (url) => Promise.resolve(zipStored(url.includes("/npm/")
      ? { "GHSA-35jh-r3h4-6jhm.json": readFileSync(path.join(osv, "GHSA-35jh-r3h4-6jhm.json")) }
      : { "PYSEC-2018-28.json": readFileSync(path.join(osv, "PYSEC-2018-28.json")) })));
  });

  const radr = async (...args: string[]) => {
    const env: Record<string, string> = { RADR_HOME: home, RADR_ACTOR: "e2e@example.com" };
    for (const k of PASS) { const v = process.env[k]; if (v !== undefined) env[k] = v; }
    const r = await run({ command: process.execPath, args: [bin, ...args], cwd: root, env, timeoutMs: 40 * 60 * 1000, okExitCodes: [0, 1, 2, 3] });
    assert.equal(r.exitCode, 0, `radr ${args.join(" ")}:\n${r.stdout.toString()}\n${r.stderr.toString()}`);
    return r.stdout.toString();
  };

  it("static lanes run in the image with the network denied, and match host mode exactly (AC2, AC3)", async () => {
    await radr("tools", "build-image");
    const hashes: string[] = [];
    for (const [slug, enforcement] of [["host", "declared"], ["ctr", "container"]] as const) {
      await radr("init", "acme", slug);
      await radr("scope", "-e", `acme-${slug}`, "--source", fixture.dir);
      const yml = path.join(home, "engagements", `acme-${slug}`, "engagement.yml");
      const { writeFileSync } = await import("node:fs");
      // Static lanes only: the comparison is about the toolchain, not the sandbox.
      writeFileSync(yml, readFileSync(yml, "utf8").replace("  enforcement: declared", `  enforcement: ${enforcement}`).replace(/\n {2}- types\n {2}- coverage/, ""));
      await radr("scope", "-e", `acme-${slug}`);
      await radr("approve", "scope", "-e", `acme-${slug}`);
      assert.match(await radr("review", "-e", `acme-${slug}`), /run R-0001: complete/);
      hashes.push((await radr("findings", "-e", `acme-${slug}`, "--hash")).trim());
    }
    assert.equal(hashes[0], hashes[1], "host and container modes produce identical findings");

    // Network-denial eval (PRD invariant 9): the same exec path the lanes use cannot reach out.
    const lock = readFileSync(path.join(home, "engagements", "acme-ctr", "toolchain.lock"), "utf8");
    const tag = /tag: (localhost\/radr-toolchain:[0-9a-f]{16})/.exec(lock)?.[1] ?? "";
    const { containerExec } = await import("../../src/toolchain/container.js");
    const { detectRuntime } = await import("../../src/sandbox/runtime.js");
    const rt = await detectRuntime(process.env);
    assert.ok(rt);
    const r = await containerExec(rt, tag, [{ path: root, readOnly: true }])({
      command: "python", args: ["-c", "import urllib.request as u; u.urlopen('https://pypi.org', timeout=5); print('REACHED')"], cwd: root,
    });
    assert.notEqual(r.outcome, "ok");
    assert.doesNotMatch(r.stdout.toString(), /REACHED/);
  });

  it("health lanes (maint, license, iac, hygiene) find the planted signals in the image, deterministically (AC7–AC10)", async () => {
    await radr("tools", "build-image");
    const health = await makeHealthFixtureRepo(path.join(root, "health"));
    const { writeFileSync } = await import("node:fs");
    const results: { hash: string; findings: Record<string, unknown>[] }[] = [];
    for (const slug of ["h1", "h2"]) {
      await radr("init", "acme", slug);
      await radr("scope", "-e", `acme-${slug}`, "--source", health.dir);
      const yml = path.join(home, "engagements", `acme-${slug}`, "engagement.yml");
      writeFileSync(yml, readFileSync(yml, "utf8")
        .replace("engagement_type: health-audit", "engagement_type: due-diligence")
        .replace("  enforcement: declared", "  enforcement: container")
        .replace(/\n {2}- types\n {2}- coverage/, "")
        .replace("  - maint\n", "  - maint\n  - license\n  - iac\n  - hygiene\n"));
      await radr("scope", "-e", `acme-${slug}`);
      await radr("approve", "scope", "-e", `acme-${slug}`);
      const out = await radr("review", "-e", `acme-${slug}`);
      assert.match(out, /run R-0001: complete/, out);
      results.push({
        hash: (await radr("findings", "-e", `acme-${slug}`, "--hash")).trim(),
        findings: (await radr("findings", "-e", `acme-${slug}`, "--json")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>),
      });
    }
    assert.equal(results[0]?.hash, results[1]?.hash, "two container runs produce identical findings");
    const findings = results[0]?.findings ?? [];
    const has = (what: string, pred: (f: Record<string, unknown>) => boolean) => { assert.ok(findings.some(pred), `expected ${what}`); };
    has("lizard very-complex tangled()", (f) => f["tool"] === "lizard" && f["file"] === "src/tangled.py" && f["severity"] === "medium");
    has("jscpd clone a.js/b.js", (f) => f["tool"] === "jscpd" && String(f["message"]).includes("src/"));
    has("hadolint DL3007", (f) => f["tool"] === "hadolint" && f["rule_id"] === "DL3007");
    has("checkov on the Dockerfile and Terraform", (f) => f["tool"] === "checkov" && f["file"] === "infra/main.tf");
    // due-diligence: strong copyleft medium → high; network copyleft high → critical.
    has("scancode GPL-3.0-only source", (f) => f["tool"] === "scancode" && f["file"] === "vendor/lib.c" && f["severity"] === "high");
    has("AGPL dependency from the SBOM", (f) => f["tool"] === "syft" && f["rule_id"] === "AGPL-3.0-only" && f["severity"] === "critical");
    has("scorecard checks", (f) => f["tool"] === "scorecard" && f["rule_id"] === "Security-Policy");

    // W4: the report's license inventory and hygiene sections come from the lanes' metrics.
    await radr("address", "-e", "acme-h1");
    const report = readFileSync(path.join(home, "engagements", "acme-h1", "report", "report.md"), "utf8");
    assert.match(report, /# Licenses/);
    assert.match(report, /\| strong-copyleft \| 1 \| 0 \|/);
    assert.match(report, /\| network-copyleft \| 0 \| 1 \|/);
    assert.match(report, /# Repository hygiene/);
    assert.match(report, /Toolchain \| container image sha256:/);
  });
});
