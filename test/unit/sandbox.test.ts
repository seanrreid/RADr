// M2 W2/W3 units: sandbox isolation flags (AC7), recipes + offline installs (AC8), parsers (AC9).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RefusedError } from "../../src/core/errors.js";
import { fingerprintDrafts } from "../../src/findings/store.js";
import type { FindingDraft } from "../../src/findings/types.js";
import { ParseError } from "../../src/normalize/adapters.js";
import { mypyAdapter, parseLcov, pct, repoRel, tscAdapter } from "../../src/normalize/sandbox-adapters.js";
import { treeHash } from "../../src/sandbox/deps.js";
import { nodeInstall, proposeRecipe, pythonInstall, q, type PythonRecipe } from "../../src/sandbox/recipe.js";
import { parseSteps, sandboxArgs, sandboxScript, type SandboxRequest } from "../../src/sandbox/runtime.js";
import { tmpDir } from "../helpers/tmp.js";

const req = (over: Partial<SandboxRequest> = {}): SandboxRequest => ({
  runtime: { name: "podman", version: "5" }, image: "docker.io/library/node@sha256:" + "a".repeat(64), name: "radr-acme-r-0001-types-js-1",
  network: false, mounts: [], workdir: ".", steps: [{ name: "install", command: "npm ci", required: true }], timeoutMs: 1000, ...over,
});

describe("sandbox isolation (AC7)", () => {
  it("runs offline, non-root, capability-free, limited, with no implicit pulls", () => {
    const args = sandboxArgs(req(), 501, 20);
    for (const flag of ["--rm", "--pull=never", "--network=none", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=2048", "--memory=4g", "--cpus=2", "--userns=keep-id", "--user=501:20"]) {
      assert.ok(args.includes(flag), `missing ${flag}`);
    }
    assert.ok(!args.includes("--privileged"));
    assert.ok(sandboxArgs(req({ network: true }), 501, 20).includes("--network=bridge"), "network only when asked");
    const docker = sandboxArgs(req({ runtime: { name: "docker", version: "27" } }), 501, 20);
    assert.ok(docker.includes("--user=501:20") && !docker.includes("--userns=keep-id"));
  });

  it("mounts the source read-only and writes only to declared mounts", () => {
    const src = tmpDir();
    const out = tmpDir();
    const args = sandboxArgs(req({ mounts: [{ host: src, container: "/src", readOnly: true }, { host: out, container: "/radr/out", readOnly: false }] }), 1, 1);
    const vols = args.flatMap((a, i) => (a === "-v" ? [args[i + 1] ?? ""] : []));
    assert.equal(vols.length, 2);
    assert.match(vols[0] ?? "", /:\/src:ro$/);
    assert.match(vols[1] ?? "", /:\/radr\/out:rw$/);
  });

  it("copies the source to writable scratch and records every step's exit code", () => {
    const script = sandboxScript("app", [{ name: "install", command: "npm ci", required: true }, { name: "test1", command: "npm test", required: false }]);
    assert.match(script, /cp -R \/src \/tmp\/work && chmod -R u\+w \/tmp\/work/);
    assert.match(script, /cd "\/tmp\/work\/app"/);
    assert.match(script, /echo "install \$rc" >> \/radr\/out\/steps.txt/);
    assert.match(script, /\[ "\$rc" -eq 0 \] \|\| exit 0/, "a failed required step stops the rest");
    assert.deepEqual(parseSteps("install 0\ntest1 1\n"), [{ name: "install", exitCode: 0 }, { name: "test1", exitCode: 1 }]);
  });

  it("rejects unsafe names, workdirs, and step names", () => {
    assert.throws(() => sandboxArgs(req({ name: "x; rm -rf /" }), 1, 1), RefusedError);
    assert.throws(() => sandboxScript("../etc", []), RefusedError);
    assert.throws(() => sandboxScript("a$(id)", []), RefusedError);
    assert.throws(() => sandboxScript(".", [{ name: "bad name", command: "true", required: false }]), RefusedError);
    assert.throws(() => parseSteps("install zero"), RefusedError);
  });
});

describe("recipes + installs (AC8)", () => {
  it("proposes a recipe from the tree, adding pinned pytest only when the client doesn't pin it", () => {
    const root = tmpDir();
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    writeFileSync(path.join(root, "tsconfig.json"), "{}");
    writeFileSync(path.join(root, "requirements.txt"), "six==1.17.0\n");
    mkdirSync(path.join(root, "tests"));
    const r = proposeRecipe(root, ["typescript-javascript", "python"]);
    assert.deepEqual(r["typescript-javascript"], { dir: ".", package_manager: "npm", test: "npm test", tsconfig: "tsconfig.json" });
    assert.deepEqual(r.python?.extra_packages, ["coverage==7.16.2", "mypy==2.4.0", "pytest==9.1.1"]);
    writeFileSync(path.join(root, "requirements.txt"), "pytest==8.0.0\n");
    assert.deepEqual(proposeRecipe(root, ["python"]).python?.extra_packages, ["coverage==7.16.2", "mypy==2.4.0"]);
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "echo \"Error: no test specified\" && exit 1" } }));
    assert.equal(proposeRecipe(root, ["typescript-javascript"])["typescript-javascript"]?.test, null);
  });

  it("derives online warm and OFFLINE install commands from one recipe", () => {
    assert.match(nodeInstall("warm"), /--cache \/radr\/cache\/npm/);
    assert.match(nodeInstall("offline"), /npm ci --offline .*--cache \/radr\/cache\/npm/);
    const py: PythonRecipe = { dir: ".", requirements: ["requirements.txt"], install_project: true, pytest_args: [], extra_packages: ["coverage==7.16.2"] };
    assert.equal(pythonInstall(py, "warm"), "python -m pip download --dest /radr/cache/wheels -r 'requirements.txt' 'coverage==7.16.2' .");
    assert.match(pythonInstall(py, "offline"), /pip install --no-index --find-links \/radr\/cache\/wheels -r 'requirements.txt'/);
    assert.throws(() => pythonInstall({ ...py, requirements: ["../x.txt"] }, "offline"), RefusedError);
    assert.equal(q("it's"), `'it'\\''s'`);
  });

  it("tree hash is order- and mtime-independent, and sees content and symlink changes", () => {
    const a = tmpDir();
    mkdirSync(path.join(a, "z"));
    writeFileSync(path.join(a, "z", "f"), "1");
    writeFileSync(path.join(a, "b"), "2");
    const b = tmpDir();
    writeFileSync(path.join(b, "b"), "2");
    mkdirSync(path.join(b, "z"));
    writeFileSync(path.join(b, "z", "f"), "1");
    assert.equal(treeHash(a).hash, treeHash(b).hash);
    assert.equal(treeHash(a).files, 2);
    writeFileSync(path.join(b, "b"), "3");
    assert.notEqual(treeHash(a).hash, treeHash(b).hash);
    symlinkSync("/etc/passwd", path.join(a, "link"));
    assert.equal(treeHash(a).files, 3, "symlink hashed by target, not followed");
  });
});

describe("sandbox parsers (AC9)", () => {
  const opts = { dir: ".", rawRef: "raw/x", toolVersion: "t", snippet: () => null };

  it("tsc: diagnostics only; summary and continuation lines ignored", () => {
    const out = tscAdapter("src/math.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.\n  continuation\nFound 1 error.\n", opts);
    assert.equal(out.length, 1);
    assert.deepEqual([out[0]?.file, out[0]?.line, out[0]?.rule_id, out[0]?.tool_severity], ["src/math.ts", 1, "TS2322", "error"]);
  });

  it("mypy -O json: maps records, refuses unknown severities", () => {
    const line = JSON.stringify({ file: "app/calc.py", line: 6, column: 11, message: "Incompatible return value", hint: null, code: "return-value", severity: "error" });
    assert.equal(mypyAdapter(`${line}\n`, opts)[0]?.rule_id, "return-value");
    assert.throws(() => mypyAdapter(JSON.stringify({ file: "a.py", line: 1, message: "m", severity: "fatal" }), opts), ParseError);
  });

  it("lcov: per-file + totals, repo-relative paths, node_modules dropped", () => {
    const lcov = "SF:/tmp/work/svc/a.js\nLF:10\nLH:7\nBRF:4\nBRH:2\nend_of_record\nSF:/tmp/work/svc/node_modules/x.js\nLF:5\nLH:5\nend_of_record\n";
    const c = parseLcov(lcov, "svc");
    assert.deepEqual(Object.keys(c.files), ["svc/a.js"]);
    assert.deepEqual(c.totals, { lines_found: 10, lines_hit: 7, branches_found: 4, branches_hit: 2 });
    assert.equal(pct(7, 10), 70);
    assert.equal(pct(0, 0), null);
    assert.throws(() => repoRel("/etc/passwd", "."), ParseError);
  });
});

describe("engine-fingerprint dedupe", () => {
  it("collapses the same fact reported by two lanes into one finding", () => {
    const d = (lane: string): FindingDraft => ({
      lane, tool: "radr-build", tool_version: "1", rule_id: "install-failed", category: "maintainability", file: "package.json", line: 0, end_line: 0,
      message: "m", tool_severity: "build-failed", snippet: null, engine_fingerprint: "build:typescript-javascript:.", cve: null, aliases: [], cvss: null, raw_ref: `raw/${lane}`, tags: [],
    });
    assert.equal(fingerprintDrafts([d("types"), d("coverage")]).length, 1);
  });
});
