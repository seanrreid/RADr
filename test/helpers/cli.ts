// Run the CLI in-process with an isolated RADR_HOME and a fixed clock.
import { fixedClock } from "../../src/core/clock.js";
import type { ExitCode } from "../../src/core/errors.js";
import { runCli } from "../../src/cli/main.js";

export interface CliRun {
  readonly code: ExitCode;
  readonly out: string;
  readonly err: string;
}

export function cliRunner(home: string, extraEnv: Record<string, string> = {}, cwd = home) {
  const clock = fixedClock("2026-10-07T14:00:00Z", 1000);
  return async (...argv: string[]): Promise<CliRun> => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(argv, {
      env: { PATH: process.env["PATH"] ?? "", RADR_HOME: home, RADR_ACTOR: "consultant@example.com", ...extraEnv },
      cwd,
      clock,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
}
