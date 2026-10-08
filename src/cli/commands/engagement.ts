// Engagement lifecycle commands: init, scope, approve, source.

import { resolveActor } from "../../core/actor.js";
import { UsageError } from "../../core/errors.js";
import { radrHome, resolveEngagement } from "../../engagement/home.js";
import { initEngagement } from "../../engagement/init.js";
import { approveScope, proposeScope } from "../../engagement/scope.js";
import { approveReport } from "../../address/gate2.js";
import { fetchSource, refsHash } from "../../engagement/source.js";
import { EventLog } from "../../state/events.js";
import { ENGAGEMENT_OPTION, parse } from "../args.js";
import type { CommandSpec } from "../context.js";

export const init: CommandSpec = {
  name: "init",
  usage: "radr init <client> <slug>",
  summary: "create an engagement folder",
  async run(args, ctx) {
    const { positionals } = parse(args, {}, 2);
    const [client, slug] = positionals as [string, string];
    const l = initEngagement(radrHome(ctx.env), client, slug, await resolveActor(ctx.env), ctx.clock);
    ctx.out(`created engagement ${l.id}`);
    ctx.out(`  ${l.dir}`);
    ctx.out(`next: radr scope -e ${l.id} --source <path-or-url-of-client-fork>`);
  },
};

export const scope: CommandSpec = {
  name: "scope",
  usage: "radr scope [-e <id>] [--source <path|url>] [--rev <rev>] [--base <rev>] [--snapshot <id>]",
  summary: "mirror the source, detect stacks, write engagement.yml + locks",
  async run(args, ctx) {
    const { values } = parse(args, { ...ENGAGEMENT_OPTION, source: { type: "string" }, rev: { type: "string" }, base: { type: "string" }, snapshot: { type: "string" } }, 0);
    const home = radrHome(ctx.env);
    const l = resolveEngagement(home, values.engagement, ctx.env, ctx.cwd);
    const r = await proposeScope({
      layout: l,
      home,
      env: ctx.env,
      actor: await resolveActor(ctx.env),
      clock: ctx.clock,
      ...(values.source !== undefined ? { source: values.source } : {}),
      ...(values.rev !== undefined ? { rev: values.rev } : {}),
      ...(values.base !== undefined ? { base: values.base } : {}),
      ...(values.snapshot !== undefined ? { snapshot: values.snapshot } : {}),
    });
    ctx.out(`${r.created ? "proposed" : "updated"} scope for ${l.id} at ${r.doc.source.sha}`);
    ctx.out(`  stacks: ${r.doc.stacks.join(", ") || "(none detected)"}`);
    if (r.detection.unsupported.length > 0) ctx.out(`  not a supported stack: ${r.detection.unsupported.join(", ")} (secrets, complexity, duplication and history still cover it; the report will say what wasn't assessed)`);
    ctx.out(`  fingerprint: ${r.fingerprint}`);
    for (const w of r.warnings) ctx.out(`  warning: ${w}`);
    ctx.out(`review ${l.engagementYml}, then: radr approve scope -e ${l.id}`);
  },
};

export const approve: CommandSpec = {
  name: "approve",
  usage: "radr approve scope | report [--accept-partial <reason>] [-e <id>]",
  summary: "Gate 1 (scope) or Gate 2 (report sign-off)",
  async run(args, ctx) {
    const { values, positionals } = parse(args, { ...ENGAGEMENT_OPTION, "accept-partial": { type: "string" } }, 1);
    const what = positionals[0];
    if (what !== "scope" && what !== "report") throw new UsageError(`unknown approval "${what ?? ""}" (expected: scope, report)`);
    const l = resolveEngagement(radrHome(ctx.env), values.engagement, ctx.env, ctx.cwd);
    const actor = await resolveActor(ctx.env);
    if (what === "report") {
      const r = approveReport(l, actor, ctx.clock, values["accept-partial"]);
      ctx.out(`report approved for ${l.id} (run ${r.runId})`);
      for (const k of ["findings_set_hash", "report_hash", "remediation_hash", "theme_hash"]) ctx.out(`  ${k.padEnd(18)} ${r.hashes[k] ?? ""}`);
      ctx.out(`next: radr render -e ${l.id}`);
      return;
    }
    if (values["accept-partial"] !== undefined) throw new UsageError("--accept-partial only applies to `approve report`");
    const r = await approveScope(l, actor, ctx.clock);
    ctx.out(`scope approved for ${l.id} at ${r.sha}`);
    ctx.out(`  fingerprint: ${r.fingerprint}`);
  },
};

export const source: CommandSpec = {
  name: "source",
  usage: "radr source fetch [-e <id>]",
  summary: "update the radr-owned mirror from its origin",
  async run(args, ctx) {
    const { values, positionals } = parse(args, { ...ENGAGEMENT_OPTION }, 1);
    if (positionals[0] !== "fetch") throw new UsageError(`unknown source action "${positionals[0] ?? ""}" (expected: fetch)`);
    const l = resolveEngagement(radrHome(ctx.env), values.engagement, ctx.env, ctx.cwd);
    await fetchSource(l.mirror);
    const refs = await refsHash(l.mirror);
    new EventLog(l.events, ctx.clock).append("source-fetched", await resolveActor(ctx.env), { refs_hash: refs.hash, refs: refs.refs });
    ctx.out(`fetched ${refs.refs.length} refs for ${l.id}; scope a new commit with: radr scope -e ${l.id} --rev <commit-ish>`);
  },
};
