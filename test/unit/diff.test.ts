// M6 W2–W3: baseline, diff scope, and the diff run (AC6, AC7, AC9) with fake tools.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fixedClock } from "../../src/core/clock.js";
import { hashBytes } from "../../src/core/determinism.js";
import { InternalError } from "../../src/core/errors.js";
import { SARIF_SCHEMA } from "../../src/diff/outputs.js";
import { makeValidator } from "../../src/schemas/validate.js";
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
    assert.match(r.out, /lint +success +continue +findings=3 surfaced=1/, "raw and surfaced counts side by side");
    assert.deepEqual((await t.lint()).map((f) => f.file), ["app/d.py"], "a.py is untouched, b.py's finding is baselined");
    const done = t.events().findLast((e) => e.type === "run-completed");
    assert.match(String((done?.data["notes"] as string[] | undefined)?.join(" ")), /diff: 2 finding\(s\) outside the change or already in the baseline were not surfaced/);
    assert.match(readFileSync(t.argsFile, "utf8"), new RegExp(`--log-opts=${t.base}\\.\\.${t.head}`), "secrets: the PR's commits only (AC9)");

    writeFileSync(path.join(t.l.dir, "baseline.json"), readFileSync(path.join(t.l.dir, "baseline.json"), "utf8").replace("R-0001", "R-0009"));
    const tampered = await t.e("review");
    assert.equal(tampered.code, 1);
    assert.match(tampered.err, /baseline\.json changed after the scope was approved/);
  });

  it("writes SARIF 2.1.0 and a PR summary of only the new findings, byte-identically (AC8)", async () => {
    const run = async () => {
      const t = await prReview();
      await t.e("baseline", "set", "--from", "R-0001");
      await t.e("scope", "--rev", t.head, "--base", t.base);
      await t.e("approve", "scope");
      const r = await t.e("review");
      assert.match(r.out, /pr output: review\/pr-[0-9a-f]{12}\.sarif/);
      const stem = path.join(t.l.dir, "review", `pr-${t.head.slice(0, 12)}`);
      return { sarif: readFileSync(`${stem}.sarif`, "utf8"), md: readFileSync(`${stem}.md`, "utf8"), t };
    };
    const a = await run();
    const b = await run();
    assert.equal(a.sarif, b.sarif);
    assert.equal(a.md, b.md);
    const doc = JSON.parse(a.sarif) as { version: string; runs: { results: { ruleId: string; level: string; locations: { physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } } }[]; partialFingerprints: Record<string, string> }[]; properties: Record<string, string> }[] };
    assert.equal(doc.version, "2.1.0");
    const [res, ...more] = doc.runs[0]?.results ?? [];
    assert.equal(more.length, 0);
    assert.deepEqual([res?.ruleId, res?.locations[0]?.physicalLocation.artifactLocation.uri, res?.locations[0]?.physicalLocation.region.startLine], ["ruff/F401", "app/d.py", 1]);
    assert.match(res?.partialFingerprints["radr/v1"] ?? "", /^sha256:/);
    assert.deepEqual([doc.runs[0]?.properties["base"], doc.runs[0]?.properties["head"]], [a.t.base, a.t.head]);
    assert.match(a.md, /^## radr review: acme\/pr, [0-9a-f]{12}\.\.\.[0-9a-f]{12}\n\n\*\*1 new finding\(s\)\*\*: 1 [a-z]+\./);
    assert.match(a.md, /\| `ruff\/F401` \| `app\/d\.py:1` \| unused import \|/);
    assert.match(a.md, /\(2 suppressed\)/);
    const outputs = a.t.events().findLast((e) => e.type === "run-completed")?.data["outputs"] as { ref: string; hash: string }[];
    assert.deepEqual(outputs.map((o) => o.ref), [`review/pr-${a.t.head.slice(0, 12)}.sarif`, `review/pr-${a.t.head.slice(0, 12)}.md`]);
    assert.equal(outputs[0]?.hash, hashBytes(a.sarif));
  });

  it("the SARIF schema check rejects what SARIF 2.1.0 forbids", () => {
    const v = makeValidator<unknown>(SARIF_SCHEMA, InternalError);
    const ok = { $schema: "https://json.schemastore.org/sarif-2.1.0.json", version: "2.1.0", runs: [{ tool: { driver: { name: "radr", rules: [] } }, results: [] }] };
    assert.doesNotThrow(() => v(ok, "sarif"));
    const bad = (r: unknown) => ({ ...ok, runs: [{ tool: ok.runs[0]?.tool, results: [r] }] });
    const result = { ruleId: "x/y", level: "error", message: { text: "m" }, locations: [{ physicalLocation: { artifactLocation: { uri: "a" }, region: { startLine: 1 } } }], partialFingerprints: { "radr/v1": "f" }, properties: {} };
    assert.doesNotThrow(() => v(bad(result), "sarif"));
    assert.throws(() => v(bad({ ...result, level: "critical" }), "sarif"), InternalError);
    assert.throws(() => v(bad({ ...result, locations: [{ physicalLocation: { artifactLocation: { uri: "a" }, region: { startLine: 0 } } }] }), "sarif"), InternalError);
  });

  it("engagement.yml: the diff tier and the diff block come together", () => {
    const yml = (tier: string, diff: string) => `version: 1\nclient: acme\nslug: t\nengagement_type: pr-review\ntier: ${tier}\nsource: { origin: /x, sha: ${"a".repeat(40)} }\npaths: { include: ["**"], exclude: [] }\nstacks: []\nlanes: [lint]\nrubric: v2\nnetwork: { mode: offline, enforcement: declared }\nllm_policy: off\nclient_licenses: []\n${diff}`;
    const block = `diff: { base: ${"b".repeat(40)}, baseline: sha256:${"0".repeat(64)} }\n`;
    assert.equal(parseEngagement(yml("diff", block), "e.yml").diff?.base, "b".repeat(40));
    assert.throws(() => parseEngagement(yml("diff", ""), "e.yml"), /diff tier needs a diff block/);
    assert.throws(() => parseEngagement(yml("standard", block), "e.yml"), /only the diff tier/);
  });
});
