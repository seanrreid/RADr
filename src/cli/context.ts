import type { Clock } from "../core/clock.js";

/** Everything a command touches from its environment, injected so tests run in-process. */
export interface CliContext {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly clock: Clock;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export interface CommandSpec {
  readonly name: string;
  readonly usage: string;
  readonly summary: string;
  run(args: readonly string[], ctx: CliContext): Promise<void>;
}
