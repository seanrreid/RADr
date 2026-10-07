// CLI dispatch. Every failure becomes exactly one stderr line and a contract exit code
// (0 ok · 1 refused · 2 usage · 3 internal).

import { systemClock } from "../core/clock.js";
import { EXIT, RadrError, type ExitCode } from "../core/errors.js";
import { approve, init, scope, source } from "./commands/engagement.js";
import type { CliContext, CommandSpec } from "./context.js";

export const COMMANDS: readonly CommandSpec[] = [init, scope, approve, source];

function help(ctx: CliContext): void {
  ctx.out("usage: radr <command> [options]\n");
  for (const c of COMMANDS) ctx.out(`  ${c.usage.padEnd(58)} ${c.summary}`);
}

export async function runCli(argv: readonly string[], ctx: CliContext): Promise<ExitCode> {
  const [name, ...rest] = argv;
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    help(ctx);
    return name === undefined ? EXIT.usage : EXIT.ok;
  }
  const cmd = COMMANDS.find((c) => c.name === name);
  if (cmd === undefined) {
    ctx.err(`radr: unknown command "${name}" (see \`radr help\`)`);
    return EXIT.usage;
  }
  try {
    await cmd.run(rest, ctx);
    return EXIT.ok;
  } catch (e) {
    if (e instanceof RadrError) {
      ctx.err(`radr ${name}: ${e.message}`);
      return e.exitCode;
    }
    ctx.err(`radr ${name}: internal error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    return EXIT.internal;
  }
}

export function processContext(): CliContext {
  return {
    env: process.env,
    cwd: process.cwd(),
    clock: systemClock,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
}
