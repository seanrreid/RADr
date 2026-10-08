// `radr verify` (M6): re-run the approved lanes at the fixed commit and mark findings fixed,
// verified, or regressed against an earlier run.

import { resolveActor } from "../../core/actor.js";
import { UsageError } from "../../core/errors.js";
import { radrHome, resolveEngagement } from "../../engagement/home.js";
import { verify } from "../../verify/verify.js";
import { ENGAGEMENT_OPTION, parse } from "../args.js";
import type { CommandSpec } from "../context.js";

export const verifyCmd: CommandSpec = {
  name: "verify",
  usage: "radr verify --against <R-id> [-e <id>]",
  summary: "re-run at the fixed commit; mark findings fixed / verified / regressed",
  async run(args, ctx) {
    const { values } = parse(args, { ...ENGAGEMENT_OPTION, against: { type: "string" } }, 0);
    if (values.against === undefined || !/^R-\d{4}$/.test(values.against)) throw new UsageError("verify needs --against <R-NNNN>: the run whose findings to re-check");
    const home = radrHome(ctx.env);
    const l = resolveEngagement(home, values.engagement, ctx.env, ctx.cwd);
    const r = await verify(home, l, values.against, await resolveActor(ctx.env), ctx.clock, ctx.env);
    ctx.out(`verify ${l.id}: ${r.run.runId} (${r.run.status}) against ${r.against}`);
    const list = (xs: readonly string[]) => (xs.length === 0 ? "" : `: ${xs.join(", ")}`);
    ctx.out(`  fixed ${String(r.fixed.length)}${list(r.fixed)}`);
    ctx.out(`  verified ${String(r.verified.length)}${list(r.verified)}`);
    ctx.out(`  regressed ${String(r.regressed.length)}${list(r.regressed)}`);
    ctx.out(`  still present ${String(r.stillPresent.length)}${list(r.stillPresent)}`);
    if (r.manual.length > 0) ctx.out(`  needs a manual check ${String(r.manual.length)}${list(r.manual)} (no code snippet: it may have moved)`);
    if (r.judgments.length > 0) ctx.out(`  judgment findings to check by hand ${String(r.judgments.length)}${list(r.judgments)} (radr disposition <J-id> fixed --reason "…")`);
    ctx.out(`next: radr address -e ${l.id} (the report gains a Verification section)`);
    if (r.run.status === "partial") ctx.out("  the run was partial: findings of lanes that didn't run clean stay fixed, not verified");
  },
};
