// M1 end-to-end proof (T6.3, T6.4) with the REAL pinned tools:
//   AC17: the full command sequence finds the planted signals, and no clear-text secret is
//         written anywhere radr owns.
//   AC18: two full runs in separate RADR_HOMEs, launched as real subprocesses under different
//         TZ/LANG, produce identical findings-set hashes.
//
// Needs installed tools: point RADR_E2E_TOOLS at a RADR_HOME where `radr tools install` ran.
// Without it the suite is skipped (CI installs tools first and sets it).

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync, symlinkSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../../src/core/exec.js";
import { FAKE_AWS_KEY_ID, makeFixtureRepo, type FixtureRepo } from "../helpers/fixture-repo.js";
import { tmpDir } from "../helpers/tmp.js";

const TOOLS_HOME = process.env["RADR_E2E_TOOLS"];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const bin = path.join(repoRoot, "bin", "radr.js");
const osvFixtures = path.join(repoRoot, "test", "fixtures", "osv");

const ADVISORIES = { npm: ["GHSA-35jh-r3h4-6jhm.json"], PyPI: ["PYSEC-2018-28.json"] } as const;

interface Env { readonly TZ: string; readonly LANG: string }

async function radr(home: string, env: Env, ...args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const r = await run({
    command: process.execPath,
    args: [bin, ...args],
    cwd: home,
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: home, RADR_HOME: home, RADR_ACTOR: "e2e@example.com", TZ: env.TZ, LANG: env.LANG, LC_ALL: env.LANG },
    timeoutMs: 10 * 60 * 1000,
    okExitCodes: [0, 1, 2, 3],
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** A fresh RADR_HOME sharing the installed tools, with a fixture OSV snapshot synced into it. */
async function freshHome(env: Env): Promise<string> {
  const home = tmpDir("radr-e2e-");
  symlinkSync(path.join(TOOLS_HOME ?? "", "tools"), path.join(home, "tools"));
  // db sync needs network; build the fixture snapshot through the same code path with a
  // fetcher that serves deterministic zips of the vendored advisories.
  const script = `
    import { readFileSync } from "node:fs";
    import { syncOsv } from ${JSON.stringify(path.join(repoRoot, "dist/src/toolchain/db.js"))};
    import { fixedClock } from ${JSON.stringify(path.join(repoRoot, "dist/src/core/clock.js"))};
    import { zipStored } from ${JSON.stringify(path.join(repoRoot, "dist/test/helpers/zip.js"))};
    const advisories = ${JSON.stringify(ADVISORIES)};
    await syncOsv(process.env.RADR_HOME, fixedClock("2026-10-01T00:00:00Z"), async (url) => {
      const eco = url.split("/").at(-2);
      const files = Object.fromEntries(advisories[eco].map((f) => [f, readFileSync(${JSON.stringify(osvFixtures)} + "/" + f)]));
      return zipStored(files);
    });`;
  const r = await run({ command: process.execPath, args: ["--input-type=module", "-e", script], cwd: home, env: { RADR_HOME: home, TZ: env.TZ, LANG: env.LANG } });
  assert.equal(r.outcome, "ok", r.stderr.toString());
  return home;
}

async function fullPipeline(fixture: FixtureRepo, env: Env): Promise<{ home: string; hash: string; findings: Record<string, unknown>[] }> {
  const home = await freshHome(env);
  const steps: string[][] = [
    ["init", "acme", "e2e"],
    ["scope", "-e", "acme-e2e", "--source", fixture.dir],
    ["approve", "scope", "-e", "acme-e2e"],
    ["review", "-e", "acme-e2e"],
  ];
  for (const s of steps) {
    const r = await radr(home, env, ...s);
    assert.equal(r.code, 0, `radr ${s.join(" ")} failed:\n${r.out}\n${r.err}`);
    if (s[0] === "review") assert.match(r.out, /run R-0001: complete/, r.out);
  }
  const hash = (await radr(home, env, "findings", "-e", "acme-e2e", "--hash")).out.trim();
  const json = (await radr(home, env, "findings", "-e", "acme-e2e", "--json")).out.trim().split("\n");
  return { home, hash, findings: json.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

function walkFiles(dir: string, skip: (p: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (skip(p)) continue;
    if (statSync(p).isDirectory()) walkFiles(p, skip, out);
    else out.push(p);
  }
  return out;
}

describe("M1 end-to-end with real tools", { skip: TOOLS_HOME === undefined ? "set RADR_E2E_TOOLS to a RADR_HOME with installed tools" : false }, () => {
  const fixtureRoot = tmpDir("radr-e2e-fixture-");
  let fixture: FixtureRepo;
  before(async () => {
    assert.ok(existsSync(path.join(TOOLS_HOME ?? "", "tools")), "RADR_E2E_TOOLS has no tools/ directory");
    fixture = await makeFixtureRepo(path.join(fixtureRoot, "client-fork"));
    mkdirSync(fixtureRoot, { recursive: true });
  });

  it("finds the planted signals and never persists the secret (AC17)", async () => {
    const { home, findings } = await fullPipeline(fixture, { TZ: "UTC", LANG: "C" });
    const has = (pred: (f: Record<string, unknown>) => boolean, what: string): void => {
      assert.ok(findings.some(pred), `expected ${what}`);
    };
    has((f) => f["tool"] === "gitleaks" && f["rule_id"] === "aws-access-token" && (f["tags"] as string[]).includes("history-only"), "history-only AWS key");
    has((f) => f["rule_id"] === "GHSA-35jh-r3h4-6jhm" && f["cve"] === "CVE-2021-23337" && f["severity"] === "high", "lodash advisory (high)");
    has((f) => f["rule_id"] === "PYSEC-2018-28" && f["file"] === "requirements.txt", "requests advisory");
    has((f) => f["tool"] === "eslint" && f["rule_id"] === "no-eval", "eslint no-eval");
    has((f) => f["tool"] === "ruff" && f["rule_id"] === "F401", "ruff F401");

    const engagement = path.join(home, "engagements", "acme-e2e");
    const owned = walkFiles(engagement, (p) => p.startsWith(path.join(engagement, "source")));
    assert.ok(owned.length > 10, "expected raw output, logs, findings, artifacts");
    for (const f of owned) assert.ok(!readFileSync(f).includes(FAKE_AWS_KEY_ID), `clear-text secret written to ${path.relative(engagement, f)}`);
  });

  it("produces identical findings-set hashes across homes, TZ, and LANG (AC18)", async () => {
    const a = await fullPipeline(fixture, { TZ: "UTC", LANG: "C" });
    const b = await fullPipeline(fixture, { TZ: "Asia/Kolkata", LANG: "de_DE.UTF-8" });
    assert.match(a.hash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(a.hash, b.hash);
    assert.deepEqual(a.findings.map((f) => f["id"]), b.findings.map((f) => f["id"]));
  });
});
