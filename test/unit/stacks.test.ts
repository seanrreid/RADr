// M3 W3: the sca lane needs the pinned OSV snapshot to cover every detected stack's ecosystem.
// A gap is warned about at scope time and refused (tool-missing → abort) at review time, with
// the missing ecosystem named, instead of osv-scanner's generic offline failure.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { cliRunner } from "../helpers/cli.js";
import { seedFakeSnapshot, seedFakeToolchain } from "../helpers/fake-toolchain.js";
import { makePolyglotFixtureRepo } from "../helpers/fixture-repo.js";
import { tmpDir } from "../helpers/tmp.js";

describe("OSV ecosystem coverage for detected stacks", () => {
  it("warns at scope and refuses sca when the snapshot lacks a stack's ecosystem", async () => {
    const repo = await makePolyglotFixtureRepo(path.join(tmpDir(), "poly"));
    const home = tmpDir();
    seedFakeToolchain(home);
    await seedFakeSnapshot(home, "2026-10-01T00:00:00Z", undefined, ["npm", "PyPI", "Go", "crates.io", "Maven", "Packagist", "RubyGems"]); // no NuGet
    const radr = cliRunner(home);
    await radr("init", "acme", "poly");
    const s = await radr("scope", "-e", "acme-poly", "--source", repo.dir);
    assert.equal(s.code, 0, s.err);
    assert.match(s.out, /stacks: csharp, go, java-kotlin, php, ruby, rust/);
    assert.match(`${s.out}\n${s.err}`, /has no NuGet database/);
    assert.equal((await radr("approve", "scope", "-e", "acme-poly")).code, 0);
    const r = await radr("review", "-e", "acme-poly");
    assert.match(r.out, /sca\s+tool-missing/);
    assert.match(`${r.out}\n${r.err}`, /pinned OSV snapshot has no NuGet database/);
    assert.match(r.out, /run R-0001: aborted/);
  });
});
