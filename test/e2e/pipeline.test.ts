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
import { existsSync, readFileSync, readdirSync, statSync, symlinkSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../../src/core/exec.js";
import { FAKE_AWS_KEY_ID, POLYGLOT, makeDiffRepo, makeFixtureRepo, makePolyglotFixtureRepo, makeVerifyRepo, type FixtureRepo } from "../helpers/fixture-repo.js";
import { promptFreeText } from "../../src/llm/prompt.js";
import { leakedRuns } from "../../src/llm/redact.js";
import { tmpDir } from "../helpers/tmp.js";

const TOOLS_HOME = process.env["RADR_E2E_TOOLS"];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const bin = path.join(repoRoot, "bin", "radr.js");
const osvFixtures = path.join(repoRoot, "test", "fixtures", "osv");

const ADVISORIES = {
  npm: ["GHSA-35jh-r3h4-6jhm.json"], PyPI: ["PYSEC-2018-28.json"], Go: ["GO-2022-1059.json"], "crates.io": ["RUSTSEC-2020-0071.json"],
  Maven: ["GHSA-jfh8-c2jp-5v3q.json"], Packagist: ["GHSA-q7rv-6hp3-vh96.json"], RubyGems: ["GHSA-3h57-hmj3-gj3p.json"], NuGet: ["GHSA-5crp-9r3c-p9vr.json"],
} as const;

interface Env { readonly TZ: string; readonly LANG: string; readonly extra?: Readonly<Record<string, string>> }

async function radr(home: string, env: Env, ...args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const r = await run({
    command: process.execPath,
    args: [bin, ...args],
    cwd: home,
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: home, RADR_HOME: home, RADR_ACTOR: "e2e@example.com", RADR_CONTAINER_RUNTIME: "none", TZ: env.TZ, LANG: env.LANG, LC_ALL: env.LANG, ...env.extra },
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

async function fullPipeline(fixture: FixtureRepo, env: Env, onScope?: (out: string) => void): Promise<{ home: string; hash: string; findings: Record<string, unknown>[] }> {
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
    if (s[0] === "scope") onScope?.(r.out);
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

    // M3 maint (real lizard + jscpd): the scorecard's complexity and duplication rows have values.
    const card = JSON.parse((await radr(home, { TZ: "UTC", LANG: "C" }, "scorecard", "-e", "acme-e2e", "--json")).out) as { rows: { key: string; value: unknown }[] };
    for (const key of ["complex_functions_pct", "duplication_pct"]) {
      assert.equal(typeof card.rows.find((r) => r.key === key)?.value, "number", `${key} should be measured`);
    }

    const engagement = path.join(home, "engagements", "acme-e2e");
    const owned = walkFiles(engagement, (p) => p.startsWith(path.join(engagement, "source")));
    assert.ok(owned.length > 10, "expected raw output, logs, findings, artifacts");
    for (const f of owned) assert.ok(!readFileSync(f).includes(FAKE_AWS_KEY_ID), `clear-text secret written to ${path.relative(engagement, f)}`);
  });

  it("M2: address → Gate 2 → render produces a byte-identical PDF on every render (AC10–AC12)", async () => {
    const env = { TZ: "UTC", LANG: "C" };
    const { home } = await fullPipeline(fixture, env);
    const ok = async (...args: string[]) => {
      const r = await radr(home, env, ...args);
      assert.equal(r.code, 0, `radr ${args.join(" ")}:\n${r.out}\n${r.err}`);
      return r.out;
    };
    // Human decisions on everything the rubric left pending (the review set).
    for (const lane of ["secrets", "sca", "lint", "sast"]) {
      const r = await radr(home, env, "disposition", "--lane", lane, "confirmed", "--reason", "e2e: reviewed", "-e", "acme-e2e");
      assert.ok(r.code === 0 || /matched no findings|can move/.test(r.err), r.err);
    }
    await ok("address", "-e", "acme-e2e");
    const report = readFileSync(path.join(home, "engagements", "acme-e2e", "report", "report.md"), "utf8");
    assert.match(report, /# Top risks/);
    await ok("approve", "report", "-e", "acme-e2e");
    const first = await ok("render", "-e", "acme-e2e");
    const pdf = path.join(home, "engagements", "acme-e2e", "report", "report.pdf");
    const bytes1 = readFileSync(pdf);
    assert.equal(bytes1.subarray(0, 5).toString(), "%PDF-");
    const second = await ok("render", "-e", "acme-e2e");
    assert.equal(first, second, "same PDF hashes on a second render");
    assert.ok(bytes1.equals(readFileSync(pdf)), "PDF bytes identical");
    assert.ok(!bytes1.includes(FAKE_AWS_KEY_ID), "no clear-text secret in the PDF");
  });

  it("produces identical findings-set hashes across homes, TZ, and LANG (AC18)", async () => {
    const a = await fullPipeline(fixture, { TZ: "UTC", LANG: "C" });
    const b = await fullPipeline(fixture, { TZ: "Asia/Kolkata", LANG: "de_DE.UTF-8" });
    assert.match(a.hash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(a.hash, b.hash);
    assert.deepEqual(a.findings.map((f) => f["id"]), b.findings.map((f) => f["id"]));
  });

  it("M4: prompts over real tool output quote no repo code (metadata-only) and never carry a secret (AC3)", async () => {
    const script = tmpDir("radr-e2e-agent-");
    const empty = JSON.stringify({ explanations: [], clusters: [], dispositions: [], judgments: [] });
    for (let i = 1; i <= 50; i++) writeFileSync(path.join(script, `response-${String(i)}`), empty);
    const agent = path.join(repoRoot, "dist", "test", "helpers", "fake-agent.js");
    const env: Env = { TZ: "UTC", LANG: "C", extra: { RADR_AGENT_CMD: JSON.stringify([process.execPath, agent, script]) } };
    const poly = await makePolyglotFixtureRepo(path.join(fixtureRoot, "polyglot-llm"));
    for (const [repo, policy] of [[poly, "metadata-only"], [fixture, "code-allowed"]] as const) {
      const home = await freshHome(env);
      const yml = path.join(home, "engagements", "acme-e2e", "engagement.yml");
      for (const s of [["init", "acme", "e2e"], ["scope", "-e", "acme-e2e", "--source", repo.dir]]) assert.equal((await radr(home, env, ...s)).code, 0);
      writeFileSync(yml, readFileSync(yml, "utf8").replace("llm_policy: off", `llm_policy: ${policy}`));
      for (const s of [["approve", "scope", "-e", "acme-e2e"], ["review", "-e", "acme-e2e"], ["triage", "-e", "acme-e2e"]]) {
        const r = await radr(home, env, ...s);
        assert.equal(r.code, 0, `radr ${s.join(" ")} (${policy}):\n${r.out}\n${r.err}`);
      }
      const llm = path.join(home, "engagements", "acme-e2e", "llm");
      const worktree = path.join(home, "engagements", "acme-e2e", "source", "worktree");
      const prompts = readdirSync(llm).filter((f) => f.endsWith(".prompt.txt")).map((f) => readFileSync(path.join(llm, f), "utf8"));
      assert.ok(prompts.length > 0, `${policy}: no prompt was sent`);
      for (const p of prompts) {
        assert.ok(!p.includes(FAKE_AWS_KEY_ID), `${policy}: a prompt carries the planted secret`);
        if (policy === "metadata-only") assert.deepEqual(leakedRuns(promptFreeText(p), worktree), [], "metadata-only prompt quotes the repository");
      }
    }
  });

  it("M6: verify marks fixed findings verified, and a PR review surfaces only new ones, byte-identically across TZ/LANG", async () => {
    // verify: real ruff flags each `import unused_…`; the fix commit removes two of three.
    const vrepo = await makeVerifyRepo(path.join(fixtureRoot, "verify"));
    const env: Env = { TZ: "UTC", LANG: "C" };
    const home = await freshHome(env);
    const step = async (h: string, e: Env, ...args: string[]) => {
      const r = await radr(h, e, ...args, "-e", "acme-e2e");
      assert.equal(r.code, 0, `radr ${args.join(" ")}:\n${r.out}\n${r.err}`);
      return r.out;
    };
    assert.equal((await radr(home, env, "init", "acme", "e2e")).code, 0);
    await step(home, env, "scope", "--source", vrepo.dir, "--rev", vrepo.commits[0] ?? "");
    await step(home, env, "approve", "scope");
    await step(home, env, "review");
    const lint = (await radr(home, env, "findings", "-e", "acme-e2e", "--json", "--lane", "lint")).out.trim().split("\n").map((l) => JSON.parse(l) as { id: string; file: string; state: string });
    assert.deepEqual(lint.map((f) => f.file).sort(), ["app/a.py", "app/b.py", "app/c.py"]);
    // Low-severity lint is auto-confirmed by the rubric; confirm anything still pending.
    for (const f of lint.filter((x) => x.state === "pending")) await step(home, env, "disposition", f.id, "confirmed");
    await step(home, env, "scope", "--rev", vrepo.commits[1] ?? "");
    await step(home, env, "approve", "scope");
    const v = await step(home, env, "verify", "--against", "R-0001");
    assert.match(v, /verified 2/);
    assert.match(v, /still present 1/);

    // PR review: two homes, different TZ/LANG, same bytes.
    const drepo = await makeDiffRepo(path.join(fixtureRoot, "diff"));
    const outputs = async (e: Env) => {
      const h = await freshHome(e);
      assert.equal((await radr(h, e, "init", "acme", "e2e")).code, 0);
      await step(h, e, "scope", "--source", drepo.dir, "--rev", drepo.commits[0] ?? "");
      await step(h, e, "approve", "scope");
      await step(h, e, "review");
      await step(h, e, "baseline", "set", "--from", "R-0001");
      await step(h, e, "scope", "--rev", drepo.commits[1] ?? "", "--base", drepo.commits[0] ?? "");
      await step(h, e, "approve", "scope");
      await step(h, e, "review");
      const stem = path.join(h, "engagements", "acme-e2e", "review", `pr-${(drepo.commits[1] ?? "").slice(0, 12)}`);
      return { sarif: readFileSync(`${stem}.sarif`, "utf8"), md: readFileSync(`${stem}.md`, "utf8") };
    };
    const a = await outputs({ TZ: "UTC", LANG: "C" });
    const b = await outputs({ TZ: "Asia/Kolkata", LANG: "de_DE.UTF-8" });
    assert.equal(a.sarif, b.sarif);
    assert.equal(a.md, b.md);
    const results = (JSON.parse(a.sarif) as { runs: { results: { ruleId: string; locations: { physicalLocation: { artifactLocation: { uri: string } } }[] }[] }[] }).runs[0]?.results ?? [];
    assert.deepEqual(results.map((r) => [r.ruleId, r.locations[0]?.physicalLocation.artifactLocation.uri]), [["ruff/F401", "app/d.py"]]);
  });

  it("M3: every new stack is detected, and sca and sast find its planted signals (AC11)", async () => {
    const poly = await makePolyglotFixtureRepo(path.join(fixtureRoot, "polyglot"));
    let scopeOut = "";
    const { findings } = await fullPipeline(poly, { TZ: "UTC", LANG: "C" }, (out) => { scopeOut = out; });
    for (const [stack, want] of Object.entries(POLYGLOT)) {
      assert.match(scopeOut, new RegExp(stack), `scope detects ${stack}`);
      assert.ok(findings.some((f) => f["lane"] === "sca" && f["rule_id"] === want.advisory), `${stack}: sca finds ${want.advisory}`);
      assert.ok(findings.some((f) => f["lane"] === "sast" && f["rule_id"] === want.rule), `${stack}: sast finds ${want.rule}`);
    }
  });
});
