// M3 W0: container toolchain (AC1, AC2).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assetPath } from "../../src/core/assets.js";
import { hashBytes } from "../../src/core/determinism.js";
import { run } from "../../src/core/exec.js";
import { parseEngagement } from "../../src/engagement/config.js";
import { assertSafeImage, toolContainerArgs, volumeFlags } from "../../src/toolchain/container.js";
import { DEBIAN_SNAPSHOT, containerfile, imageTag, toolSpecs } from "../../src/toolchain/image.js";
import { tmpDir } from "../helpers/tmp.js";

const rt = { name: "podman" as const, version: "5" };

describe("container exec isolation (AC2)", () => {
  it("runs every tool with no network, no capabilities, as the invoking user, without host PATH", () => {
    const wt = tmpDir();
    const args = toolContainerArgs(rt, "localhost/radr-toolchain:0123456789abcdef", { command: "scc", args: ["--version"], cwd: wt, env: { PATH: "/evil", HOME: "/h" } }, [{ path: wt, readOnly: true }], 501, 20);
    for (const flag of ["--rm", "--pull=never", "--network=none", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--userns=keep-id", "--user=501:20"]) {
      assert.ok(args.includes(flag), `missing ${flag}`);
    }
    assert.ok(!args.some((a) => a.startsWith("PATH=")), "host PATH must never reach the container");
    assert.ok(args.includes("LC_ALL=C") && args.includes("TZ=UTC"), "pinned locale/timezone");
    assert.deepEqual(args.slice(-3), ["localhost/radr-toolchain:0123456789abcdef", "scc", "--version"]);
  });

  it("mounts host paths at the SAME path, plus their symlinked alias", () => {
    const real = tmpDir();
    const alias = path.join(tmpDir(), "alias");
    symlinkSync(real, alias);
    const flags = volumeFlags([{ path: alias, readOnly: true }]);
    const vols = flags.filter((_, i) => flags[i - 1] === "-v");
    assert.equal(vols.length, 2);
    assert.ok(vols.every((v) => v.endsWith(":ro")));
    assert.ok(vols.some((v) => v.endsWith(`:${alias}:ro`)), "the alias path resolves inside the container too");
  });

  it("only accepts radr's own image references", () => {
    assert.equal(assertSafeImage("localhost/radr-toolchain:0123456789abcdef"), "localhost/radr-toolchain:0123456789abcdef");
    assert.throws(() => assertSafeImage("docker.io/evil/radr:latest"));
  });

  it("container enforcement requires an offline scope", () => {
    const yml = (mode: string) => `version: 1\nclient: acme\nslug: x\nengagement_type: health-audit\ntier: standard\nsource: { origin: /x, sha: ${"a".repeat(40)} }\npaths: { include: ["**"], exclude: [] }\nstacks: []\nlanes: [lint]\nrubric: v1\nnetwork: { mode: ${mode}, enforcement: container }\nllm_policy: off\nclient_licenses: []\n`;
    assert.equal(parseEngagement(yml("offline"), "e.yml").network.enforcement, "container");
    assert.throws(() => parseEngagement(yml("network"), "e.yml"), /requires network mode "offline"/);
  });
});

describe("toolchain image build inputs (AC1)", () => {
  it("pins bases by digest, verifies in-build, hash-locks Python, ignores npm scripts, freezes apt", () => {
    const cf = containerfile();
    assert.match(cf, /^FROM docker\.io\/library\/node@sha256:[0-9a-f]{64} AS nodetools$/m);
    assert.match(cf, /^FROM docker\.io\/library\/python@sha256:[0-9a-f]{64}$/m);
    assert.match(cf, /npm ci --ignore-scripts/);
    assert.match(cf, /pip install .*--require-hashes --no-deps/);
    assert.match(cf, new RegExp(`snapshot\\.debian\\.org/archive/debian/${DEBIAN_SNAPSHOT}`));
    assert.match(cf, /fetch\.py .*tools\.json "\$TARGETARCH"/);
    assert.doesNotMatch(cf, /:latest|curl .*\| *sh/);
  });

  it("every Python requirement carries hashes", () => {
    const req = readFileSync(assetPath("toolchain/py-tools/requirements.txt"), "utf8");
    const pkgs = req.split("\n").filter((l) => /^[a-z0-9-]+==/.test(l));
    assert.ok(pkgs.length > 50);
    for (const block of req.split(/\n(?=[a-z0-9-]+==)/).slice(1)) assert.match(block, /--hash=sha256:[0-9a-f]{64}/, block.slice(0, 40));
  });

  it("tool specs cover both Linux platforms for every manifest tool", () => {
    const specs = toolSpecs() as Record<string, { tool: string; sha256: string }[]>;
    assert.deepEqual(Object.keys(specs), ["linux-x64", "linux-arm64"]);
    assert.equal(specs["linux-x64"]?.length, specs["linux-arm64"]?.length);
    assert.match(imageTag(hashBytes("x")), /^localhost\/radr-toolchain:[0-9a-f]{16}$/);
  });
});

describe("fetch.py (in-build verification)", { skip: existsSync("/usr/bin/python3") ? false : "needs python3" }, () => {
  const fetch = assetPath("toolchain/image/fetch.py");
  async function bundle(files: Record<string, string>, tamper = false) {
    const dir = tmpDir();
    const src = path.join(dir, "src");
    mkdirSync(path.join(src, "pkg"), { recursive: true });
    for (const [n, c] of Object.entries(files)) writeFileSync(path.join(src, n), c, { mode: 0o755 });
    const tgz = path.join(dir, "a.tar.gz");
    await run({ command: "tar", args: ["-czf", tgz, "-C", src, ...Object.keys(files)], cwd: dir, inheritEnv: ["PATH"] });
    const sha = hashBytes(readFileSync(tgz)).slice(7);
    const spec = { "linux-arm64": [{ tool: "demo", version: "1", url: `file://${tgz}`, sha256: tamper ? "0".repeat(64) : sha, archive: "tar.gz", bin: Object.keys(files)[0] }] };
    writeFileSync(path.join(dir, "tools.json"), JSON.stringify(spec));
    const r = await run({ command: "/usr/bin/python3", args: [fetch, path.join(dir, "tools.json"), "arm64", path.join(dir, "out")], cwd: dir });
    return { r, dir };
  }

  it("installs a verified artifact", async () => {
    const { r, dir } = await bundle({ "pkg/demo": "#!/bin/sh\necho hi\n" });
    assert.equal(r.outcome, "ok", r.stderr.toString());
    assert.ok(existsSync(path.join(dir, "out", "demo", "1", "pkg", "demo")));
  });

  it("fails the build on a checksum mismatch, before extracting anything", async () => {
    const { r, dir } = await bundle({ "pkg/demo": "x" }, true);
    assert.notEqual(r.outcome, "ok");
    assert.match(r.stderr.toString(), /checksum mismatch/);
    assert.equal(existsSync(path.join(dir, "out", "demo")), false);
  });
});
