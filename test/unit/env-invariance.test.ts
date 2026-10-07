import { it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../../src/core/exec.js";

const probe = path.join(path.dirname(fileURLToPath(import.meta.url)), "../helpers/hash-probe.js");

it("hashes are identical across TZ and LANG settings (AC3)", async () => {
  const envs = [
    { TZ: "UTC", LANG: "C", LC_ALL: "C" },
    { TZ: "Asia/Kolkata", LANG: "de_DE.UTF-8", LC_ALL: "de_DE.UTF-8" },
    { TZ: "America/Los_Angeles", LANG: "tr_TR.UTF-8", LC_ALL: "tr_TR.UTF-8" },
  ];
  const outputs = await Promise.all(
    envs.map((env) => run({ command: process.execPath, args: [probe], cwd: process.cwd(), env })),
  );
  for (const r of outputs) assert.equal(r.outcome, "ok", r.stderr.toString());
  const lines = new Set(outputs.map((r) => r.stdout.toString()));
  assert.equal(lines.size, 1, `hashes differed: ${[...lines].join(" | ")}`);
});
