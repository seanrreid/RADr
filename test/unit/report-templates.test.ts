// Report templates per engagement type (PRD §5, §12): golden report.md for each type, from the
// same fixture run (fake tools replaying real recorded output: a secret, a lint finding, a
// dependency CVE, SAST findings). Regenerate with UPDATE_GOLDEN=1 and review the diff.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { layout } from "../../src/engagement/home.js";
import { cliRunner } from "../helpers/cli.js";
import { seedHome, setFakeTool } from "../helpers/fake-toolchain.js";
import { makeFixtureRepo, type FixtureRepo } from "../helpers/fixture-repo.js";
import { tmpDir } from "../helpers/tmp.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const golden = path.join(repoRoot, "test", "golden", "reports");
const fixtureRoot = tmpDir();
let fixture: FixtureRepo;
before(async () => { fixture = await makeFixtureRepo(path.join(fixtureRoot, "fork")); });

const RUFF = `P=$(pwd -P); printf '[{"filename":"%s/app/main.py","code":"F401","message":"unused import","location":{"row":1},"end_location":{"row":1}}]' "$P"`;
const GITLEAKS = `while [ $# -gt 0 ]; do if [ "$1" = "--report-path" ]; then shift; printf '[{"RuleID":"aws-access-token","Description":"AWS key","StartLine":2,"EndLine":2,"Secret":"REDACTED","Match":"REDACTED","File":"config/deploy.env","Commit":"98f8ed3e3ef3e67a990e53ac3cb526772b79ab73","Fingerprint":"98f8:config/deploy.env:aws-access-token:2"}]' > "$1"; fi; shift; done`;
const OSV = `sed "s#/REPO#$(pwd -P)#g" ${path.join(repoRoot, "test", "golden", "osv-scanner", "input.json")}`;
const OPENGREP = `cat ${path.join(repoRoot, "test", "golden", "opengrep", "input.json")}`;

async function reportFor(type: string): Promise<string> {
  const home = tmpDir();
  await seedHome(home);
  setFakeTool(home, "ruff", RUFF);
  setFakeTool(home, "gitleaks", GITLEAKS);
  setFakeTool(home, "osv-scanner", OSV);
  setFakeTool(home, "opengrep", OPENGREP);
  const radr = cliRunner(home);
  const e = (...a: string[]) => radr(...a, "-e", "acme-audit");
  await radr("init", "acme", "audit");
  assert.equal((await e("scope", "--source", fixture.dir)).code, 0);
  const l = layout(home, "acme-audit");
  let yml = readFileSync(l.engagementYml, "utf8").replace(/engagement_type: [a-z-]+/, `engagement_type: ${type}`);
  if (type === "triage") yml = yml.replace("tier: standard", "tier: triage").replace("  - sast\n", "");
  writeFileSync(l.engagementYml, yml);
  assert.equal((await e("approve", "scope")).code, 0);
  const r = await e("review");
  assert.equal(r.code, 0, r.err);
  assert.equal((await e("address")).code, 0);
  return readFileSync(path.join(l.dir, "report", "report.md"), "utf8");
}

function check(name: string, actual: string): void {
  const file = path.join(golden, `${name}.md`);
  if (process.env["UPDATE_GOLDEN"] === "1" || !existsSync(file)) {
    mkdirSync(golden, { recursive: true });
    writeFileSync(file, actual);
  }
  assert.equal(actual, readFileSync(file, "utf8"), `${name} report changed (UPDATE_GOLDEN=1 to accept, then review the diff)`);
}

describe("report templates per engagement type", () => {
  for (const type of ["health-audit", "triage", "quality", "security", "due-diligence"]) {
    it(type, async () => {
      check(type, await reportFor(type));
    });
  }
});
