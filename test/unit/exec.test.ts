import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildEnv, run } from "../../src/core/exec.js";
import { hashBytes } from "../../src/core/determinism.js";

const node = process.execPath;
const cwd = process.cwd();
const script = (code: string) => ["-e", code];

describe("exec.run", () => {
  it("captures stdout/stderr and hashes them", async () => {
    const r = await run({ command: node, args: script("process.stdout.write('out'); process.stderr.write('err')"), cwd });
    assert.equal(r.outcome, "ok");
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.toString(), "out");
    assert.equal(r.stdoutHash, hashBytes("out"));
    assert.equal(r.stderrHash, hashBytes("err"));
  });

  it("never uses a shell: metacharacters are passed literally", async () => {
    const r = await run({ command: node, args: [...script("process.stdout.write(process.argv[1])"), "$(echo pwned); `id` | cat"], cwd });
    assert.equal(r.stdout.toString(), "$(echo pwned); `id` | cat");
  });

  it("classifies a missing binary as tool-missing", async () => {
    const r = await run({ command: "/nonexistent/radr-tool", args: [], cwd });
    assert.equal(r.outcome, "tool-missing");
    assert.equal(r.exitCode, null);
  });

  it("treats non-zero as failure unless allowlisted (gitleaks exits 1 on leaks)", async () => {
    const fail = await run({ command: node, args: script("process.exit(1)"), cwd });
    assert.equal(fail.outcome, "nonzero-exit");
    const ok = await run({ command: node, args: script("process.exit(1)"), cwd, okExitCodes: [0, 1] });
    assert.equal(ok.outcome, "ok");
    assert.equal(ok.exitCode, 1);
  });

  it("kills on timeout", async () => {
    const r = await run({ command: node, args: script("setTimeout(() => {}, 60000)"), cwd, timeoutMs: 200 });
    assert.equal(r.outcome, "timeout");
  });

  it("kills on output cap instead of silently truncating", async () => {
    const r = await run({ command: node, args: script("process.stdout.write('x'.repeat(1e6))"), cwd, maxOutputBytes: 1024 });
    assert.equal(r.outcome, "output-cap");
  });
});

describe("exec.buildEnv", () => {
  it("inherits only allowlisted vars and pins locale/timezone", () => {
    const env = buildEnv({ inheritEnv: ["PATH"] }, { PATH: "/bin", SECRET_TOKEN: "x", LANG: "de_DE.UTF-8", TZ: "Asia/Tokyo" });
    assert.deepEqual(env, { LC_ALL: "C", LANG: "C", TZ: "UTC", PATH: "/bin" });
  });
  it("lets explicit env override the pinned defaults", () => {
    assert.equal(buildEnv({ env: { TZ: "Asia/Kolkata" } }, {})["TZ"], "Asia/Kolkata");
  });
  it("skips allowlisted names that aren't set on the host", () => {
    assert.equal("HOME" in buildEnv({ inheritEnv: ["HOME"] }, {}), false);
  });
});
