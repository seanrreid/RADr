import { parseArgs, type ParseArgsConfig } from "node:util";
import { UsageError } from "../core/errors.js";

type Options = NonNullable<ParseArgsConfig["options"]>;

/** util.parseArgs with strict mode, converting its errors into UsageError (exit 2). */
export function parse<O extends Options>(args: readonly string[], options: O, positionals: number) {
  let parsed;
  try {
    parsed = parseArgs({ args: [...args], options, strict: true, allowPositionals: true });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  if (parsed.positionals.length !== positionals) {
    throw new UsageError(`expected ${positionals} positional argument(s), got ${parsed.positionals.length}`);
  }
  return parsed;
}

/** Shared --engagement option for commands that act on an existing engagement. */
export const ENGAGEMENT_OPTION = { engagement: { type: "string", short: "e" } } as const;
