// A test stand-in for runSandbox: runs the steps on the host, with each container mount path
// rewritten to its host path and /src copied to a writable scratch dir, exactly as the real
// sandbox script does. It has none of the sandbox's isolation, so it's for tests of radr's own
// logic only; the real sandbox is covered by the e2e suite.

import { appendFileSync, cpSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { hashBytes } from "../../src/core/determinism.js";
import { run } from "../../src/core/exec.js";
import type { SandboxRequest, SandboxResult } from "../../src/sandbox/runtime.js";
import { tmpDir } from "./tmp.js";

export async function localSandbox(req: SandboxRequest, outDir: string): Promise<SandboxResult> {
  const scratch = tmpDir("radr-local-sandbox-");
  const work = path.join(scratch, "work");
  const src = req.mounts.find((m) => m.container === "/src");
  if (src === undefined) throw new Error("no /src mount");
  cpSync(src.host, work, { recursive: true });
  chmodSync(work, 0o755);
  // Longest container path first, so /radr/out isn't rewritten as /radr + "/out".
  const mounts = [...req.mounts.filter((m) => m.container !== "/src"), { host: work, container: "/tmp/work", readOnly: false }]
    .sort((a, b) => b.container.length - a.container.length);
  const rewrite = (cmd: string) => mounts.reduce((c, m) => c.split(m.container).join(m.host), cmd);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "steps.txt"), "");
  const steps: { name: string; exitCode: number }[] = [];
  for (const s of req.steps) {
    const r = await run({ command: "sh", args: ["-c", rewrite(s.command)], cwd: path.join(work, req.workdir), inheritEnv: ["PATH"], env: { HOME: scratch, ...req.env }, okExitCodes: Array.from({ length: 256 }, (_, i) => i) });
    writeFileSync(path.join(outDir, `${s.name}.log`), Buffer.concat([r.stdout, r.stderr]));
    const code = r.exitCode ?? 255;
    appendFileSync(path.join(outDir, "steps.txt"), `${s.name} ${String(code)}\n`);
    steps.push({ name: s.name, exitCode: code });
    if (s.required && code !== 0) break;
  }
  const empty = Buffer.alloc(0);
  return { exec: { outcome: "ok", exitCode: 0, signal: null, stdout: empty, stderr: empty, stdoutHash: hashBytes(empty), stderrHash: hashBytes(empty) }, steps };
}
