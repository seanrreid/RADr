// `radr baseline` (M6): record the findings of a completed run as the diff tier's baseline.

import { readFileSync } from "node:fs";
import { resolveActor } from "../../core/actor.js";
import { UsageError } from "../../core/errors.js";
import { baselineFile, setBaseline, type Baseline } from "../../diff/baseline.js";
import { radrHome, resolveEngagement } from "../../engagement/home.js";
import { EventLog } from "../../state/events.js";
import { ENGAGEMENT_OPTION, parse } from "../args.js";
import type { CommandSpec } from "../context.js";

export const baseline: CommandSpec = {
  name: "baseline",
  usage: "radr baseline set --from <R-id> | show [-e <id>]",
  summary: "the diff tier's baseline: the findings a PR review won't re-report",
  async run(args, ctx) {
    const { values, positionals } = parse(args, { ...ENGAGEMENT_OPTION, from: { type: "string" } }, 1);
    const l = resolveEngagement(radrHome(ctx.env), values.engagement, ctx.env, ctx.cwd);
    if (positionals[0] === "show") {
      const b = JSON.parse(readFileSync(baselineFile(l), "utf8")) as Baseline;
      ctx.out(`baseline from ${b.run_id}${b.commit === null ? "" : ` at ${b.commit.slice(0, 12)}`}: ${String(b.fingerprints.length)} finding(s)`);
      return;
    }
    if (positionals[0] !== "set") throw new UsageError(`unknown baseline action "${positionals[0] ?? ""}" (expected: set, show)`);
    if (values.from === undefined || !/^R-\d{4}$/.test(values.from)) throw new UsageError("baseline set needs --from <R-NNNN>");
    const r = setBaseline(l, values.from);
    new EventLog(l.events, ctx.clock).append("baseline-set", await resolveActor(ctx.env), { run_id: values.from, baseline_hash: r.hash, findings: r.baseline.fingerprints.length });
    ctx.out(`baseline: ${String(r.baseline.fingerprints.length)} finding(s) from ${values.from}`);
    ctx.out(`next, per PR: radr source fetch; radr scope --rev <head> --base <base> -e ${l.id}; radr approve scope; radr review`);
  },
};
