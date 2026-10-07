import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fixedClock } from "../../src/core/clock.js";
import { hashBytes } from "../../src/core/determinism.js";
import { RefusedError } from "../../src/core/errors.js";
import { run } from "../../src/core/exec.js";
import { OSV_SUBDIR, buildSnapshotsLock, listSnapshots, syncOsv, verifySnapshot } from "../../src/toolchain/db.js";
import { buildLock, checkTool, diffLocks, doctor } from "../../src/toolchain/doctor.js";
import { installTool, readReceipt, toolDir } from "../../src/toolchain/install.js";
import { PLATFORMS, currentPlatform, loadManifest, type Manifest } from "../../src/toolchain/manifest.js";
import { parseChecksums } from "../../scripts/pin-toolchain.js";
import { seedFakeToolchain } from "../helpers/fake-toolchain.js";
import { tmpDir } from "../helpers/tmp.js";

const SCRIPT = "#!/bin/sh\necho 'faketool 1.2.3'\n";

/** Build a real tar.gz containing bin/faketool, and a manifest that pins its true checksum. */
async function fakeRelease(): Promise<{ manifest: Manifest; archive: Uint8Array }> {
  const dir = tmpDir();
  mkdirSync(path.join(dir, "pkg", "bin"), { recursive: true });
  writeFileSync(path.join(dir, "pkg", "bin", "faketool"), SCRIPT, { mode: 0o755 });
  const r = await run({ command: "tar", args: ["-czf", path.join(dir, "rel.tar.gz"), "-C", path.join(dir, "pkg"), "bin"], cwd: dir, inheritEnv: ["PATH"] });
  assert.equal(r.outcome, "ok", r.stderr.toString());
  const archive = new Uint8Array(readFileSync(path.join(dir, "rel.tar.gz")));
  const asset = { url: "https://github.com/x/faketool/releases/download/v1/rel.tar.gz", sha256: hashBytes(archive).slice(7), archive: "tar.gz" as const, bin: "bin/faketool" };
  const manifest: Manifest = {
    version: 1,
    tools: { faketool: { version: "1.2.3", license: "MIT", source: "x", checksums_from: "x", version_args: ["--version"], version_pattern: "faketool ([0-9.]+)", platforms: Object.fromEntries(PLATFORMS.map((p) => [p, asset])) as Manifest["tools"][string]["platforms"] } },
  };
  return { manifest, archive };
}

describe("installTool (T3.2, AC10)", () => {
  it("verifies the checksum, extracts, writes a receipt, and is idempotent", async () => {
    const home = tmpDir();
    const { manifest, archive } = await fakeRelease();
    let downloads = 0;
    const fetcher = () => { downloads++; return Promise.resolve(archive); };
    assert.equal(await installTool(home, "faketool", manifest, fetcher), "installed");
    const receipt = readReceipt(toolDir(home, "faketool", "1.2.3"));
    assert.equal(receipt?.bin, "bin/faketool");
    assert.equal(await installTool(home, "faketool", manifest, fetcher), "already-installed");
    assert.equal(downloads, 1);
    assert.equal((await checkTool(home, "faketool", manifest)).state, "ok");
  });

  it("refuses a checksum mismatch and installs nothing", async () => {
    const home = tmpDir();
    const { manifest } = await fakeRelease();
    const tampered = () => Promise.resolve(new TextEncoder().encode("malicious payload"));
    await assert.rejects(installTool(home, "faketool", manifest, tampered), /checksum mismatch/);
    assert.equal(existsSync(toolDir(home, "faketool", "1.2.3")), false);
  });

  it("detects a binary modified after install, and a version that doesn't match the pin", async () => {
    const home = tmpDir();
    const { manifest, archive } = await fakeRelease();
    await installTool(home, "faketool", manifest, () => Promise.resolve(archive));
    const bin = path.join(toolDir(home, "faketool", "1.2.3"), "bin/faketool");
    appendFileSync(bin, "# tampered\n");
    assert.equal((await checkTool(home, "faketool", manifest)).state, "drift");

    const home2 = tmpDir();
    await installTool(home2, "faketool", manifest, () => Promise.resolve(archive));
    const entry = manifest.tools["faketool"];
    assert.ok(entry);
    const bumped: Manifest = { ...manifest, tools: { faketool: { ...entry, version_pattern: "faketool (9.9.9)" } } };
    const check = await checkTool(home2, "faketool", bumped);
    assert.equal(check.state, "drift");
  });

  it("reports a never-installed tool as missing", async () => {
    const { manifest } = await fakeRelease();
    assert.equal((await checkTool(tmpDir(), "faketool", manifest)).state, "missing");
  });
});

describe("doctor + toolchain.lock (T3.3)", () => {
  it("passes on a healthy toolchain and builds a deterministic lock", async () => {
    const home = tmpDir();
    seedFakeToolchain(home);
    const checks = await doctor(home);
    assert.deepEqual(checks.filter((c) => c.state !== "ok"), []);
    assert.deepEqual(buildLock(checks), buildLock(await doctor(home)));
    assert.deepEqual(Object.keys(buildLock(checks).tools), ["gitleaks", "opengrep", "osv-scanner", "pandoc", "ruff", "scc", "syft", "typst"]);
  });

  it("refuses to build a lock while any tool is missing", async () => {
    await assert.rejects(async () => buildLock(await doctor(tmpDir())), RefusedError);
  });

  it("diffLocks names every drifted item", async () => {
    const home = tmpDir();
    seedFakeToolchain(home);
    const lock = buildLock(await doctor(home));
    const live = { ...lock, tools: { ...lock.tools, ruff: { version: "0.17.0", bin_sha256: "sha256:x" } }, configs: { ...lock.configs, ruff_baseline: "sha256:y" } };
    assert.deepEqual(diffLocks(lock, live), ["ruff: locked 0.16.10 ≠ live 0.17.0", "config ruff_baseline: changed"]);
    assert.deepEqual(diffLocks(lock, lock), []);
  });
});

describe("OSV snapshots (T3.4, AC11)", () => {
  const fake = (url: string) => Promise.resolve(new TextEncoder().encode(`db:${url}`));

  it("writes the osv-scanner v2 layout and a content-addressed id", async () => {
    const home = tmpDir();
    const info = await syncOsv(home, fixedClock("2026-10-07T12:00:00Z"), fake, ["npm", "PyPI"]);
    assert.match(info.id, /^20261007-[0-9a-f]{12}$/);
    assert.ok(existsSync(path.join(home, "snapshots", "osv", info.id, OSV_SUBDIR, "PyPI", "all.zip")));
    const again = await syncOsv(home, fixedClock("2026-10-07T18:00:00Z"), fake, ["npm", "PyPI"]);
    assert.equal(again.id, info.id, "same day + same content = same snapshot");
    assert.deepEqual(buildSnapshotsLock(info).osv?.ecosystems, { npm: hashBytes("db:https://osv-vulnerabilities.storage.googleapis.com/npm/all.zip"), PyPI: hashBytes("db:https://osv-vulnerabilities.storage.googleapis.com/PyPI/all.zip") });
  });

  it("lists snapshots oldest-first and detects tampering", async () => {
    const home = tmpDir();
    const a = await syncOsv(home, fixedClock("2026-10-01T00:00:00Z"), fake, ["npm"]);
    const b = await syncOsv(home, fixedClock("2026-10-05T00:00:00Z"), (u) => Promise.resolve(new TextEncoder().encode(`newer:${u}`)), ["npm"]);
    assert.deepEqual(listSnapshots(home).map((s) => s.id), [a.id, b.id]);
    writeFileSync(path.join(home, "snapshots", "osv", a.id, OSV_SUBDIR, "npm", "all.zip"), "tampered");
    assert.throws(() => verifySnapshot(home, a.id), /altered/);
    assert.throws(() => verifySnapshot(home, "20990101-nope"), /not found/);
  });
});

describe("manifest + pin script", () => {
  it("the shipped manifest is valid and pins every platform", () => {
    const m = loadManifest();
    for (const t of Object.values(m.tools)) for (const p of PLATFORMS) assert.match(t.platforms[p].sha256, /^[0-9a-f]{64}$/);
    assert.ok(PLATFORMS.includes(currentPlatform()));
  });

  it("parseChecksums handles goreleaser and coreutils formats", () => {
    const sums = parseChecksums(`${"a".repeat(64)}  tool_linux.tar.gz\n${"b".repeat(64)} *dist/tool_darwin.tar.gz\njunk line\n`);
    assert.equal(sums.get("tool_linux.tar.gz"), "a".repeat(64));
    assert.equal(sums.get("tool_darwin.tar.gz"), "b".repeat(64));
    assert.equal(sums.size, 2);
  });
});
