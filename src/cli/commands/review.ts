// Review commands: review, findings, disposition, status.

import { resolveActor } from "../../core/actor.js";
import { canonicalJson, stableSort } from "../../core/determinism.js";
import { RefusedError, UsageError } from "../../core/errors.js";
import { loadEngagement } from "../../engagement/config.js";
import { radrHome, resolveEngagement } from "../../engagement/home.js";
import { checkTransition, dispositions, isState, stateOf } from "../../findings/disposition.js";
import { findingsSetHash, latestRunFindings, readStore } from "../../findings/store.js";
import { SEVERITIES, type Finding } from "../../findings/types.js";
import { review as runReview } from "../../review/run.js";
import { EventLog } from "../../state/events.js";
import { readScopeInputs, scopeFingerprint } from "../../state/fingerprint.js";
import { Gates } from "../../state/gates.js";
import { ENGAGEMENT_OPTION, parse } from "../args.js";
import type { CliContext, CommandSpec } from "../context.js";

const sevRank = (s: string): number => SEVERITIES.indexOf(s as Finding["severity"]);

export const review: CommandSpec = {
  name: "review",
  usage: "radr review [-e <id>]",
  summary: "run the approved scope's lanes and ingest findings",
  async run(args, ctx) {
    const { values } = parse(args, { ...ENGAGEMENT_OPTION }, 0);
    const home = radrHome(ctx.env);
    const l = resolveEngagement(home, values.engagement, ctx.env, ctx.cwd);
    const r = await runReview(home, l, await resolveActor(ctx.env), ctx.clock);
    ctx.out(`run ${r.runId}: ${r.status}`);
    for (const s of r.lanes) {
      ctx.out(`  ${s.lane.padEnd(8)} ${s.outcome.padEnd(14)} ${s.action.padEnd(9)} findings=${s.findings}${s.attempts > 1 ? ` attempts=${s.attempts}` : ""}`);
      if (s.detail !== undefined && s.outcome !== "success") ctx.out(`           ${s.detail}`);
    }
    if (r.setHash !== null) ctx.out(`findings: ${r.findings} present (${r.added} new); set ${r.setHash}`);
    if (r.status === "aborted") throw new RefusedError(`run ${r.runId} aborted (see lane outcomes above)`);
  },
};

function printFinding(ctx: CliContext, f: Finding, state: string): void {
  const loc = f.line > 0 ? `${f.file}:${f.line}` : f.file;
  ctx.out(`${f.id}  ${f.severity.padEnd(8)} ${state.padEnd(9)} ${f.lane.padEnd(7)} ${f.tool}/${f.rule_id}  ${loc}`);
  ctx.out(`        ${f.message}`);
}

export const findings: CommandSpec = {
  name: "findings",
  usage: "radr findings [-e <id>] [--severity <min>] [--lane <l>] [--state <s>] [--hash] [--json]",
  summary: "list findings from the latest run",
  run(args, ctx) {
    const { values } = parse(args, {
      ...ENGAGEMENT_OPTION, severity: { type: "string" }, lane: { type: "string" }, state: { type: "string" },
      hash: { type: "boolean" }, json: { type: "boolean" },
    }, 0);
    const l = resolveEngagement(radrHome(ctx.env), values.engagement, ctx.env, ctx.cwd);
    const { runId, findings: present } = latestRunFindings(l.findings);
    if (values.hash === true) {
      ctx.out(findingsSetHash(present));
      return;
    }
    if (values.severity !== undefined && sevRank(values.severity) < 0) throw new UsageError(`unknown severity "${values.severity}"`);
    if (values.state !== undefined && !isState(values.state)) throw new UsageError(`unknown state "${values.state}"`);
    const states = dispositions(new EventLog(l.events, ctx.clock).read());
    const selected = stableSort(
      present.filter((f) =>
        (values.severity === undefined || sevRank(f.severity) >= sevRank(values.severity)) &&
        (values.lane === undefined || f.lane === values.lane) &&
        (values.state === undefined || stateOf(states, f.id) === values.state)),
      (f) => [-sevRank(f.severity), f.id],
    );
    if (values.json === true) {
      for (const f of selected) ctx.out(canonicalJson({ ...f, state: stateOf(states, f.id) }));
      return;
    }
    if (runId === null) {
      ctx.out("no findings yet (run `radr review`)");
      return;
    }
    for (const f of selected) printFinding(ctx, f, stateOf(states, f.id));
    ctx.out(`${selected.length} of ${present.length} findings (run ${runId})`);
  },
};

export const disposition: CommandSpec = {
  name: "disposition",
  usage: "radr disposition <F-id> <confirmed|dismissed|waived> [--reason <text>] [-e <id>]",
  summary: "record a consultant decision on a finding",
  async run(args, ctx) {
    const { values, positionals } = parse(args, { ...ENGAGEMENT_OPTION, reason: { type: "string" } }, 2);
    const [id, to] = positionals as [string, string];
    if (!isState(to)) throw new UsageError(`unknown state "${to}"`);
    const l = resolveEngagement(radrHome(ctx.env), values.engagement, ctx.env, ctx.cwd);
    const known = readStore(l.findings).findings.find((f) => f.id === id);
    if (known === undefined) throw new UsageError(`no finding ${id} in ${l.id}`);
    const log = new EventLog(l.events, ctx.clock);
    const from = stateOf(dispositions(log.read()), id);
    checkTransition(from, to, values.reason);
    log.append("finding-disposition", await resolveActor(ctx.env), {
      finding_id: id, from, to, ...(values.reason !== undefined ? { reason: values.reason } : {}),
    });
    ctx.out(`${id}: ${from} → ${to}`);
  },
};

export const status: CommandSpec = {
  name: "status",
  usage: "radr status [-e <id>]",
  summary: "gate state, last run, finding counts",
  run(args, ctx) {
    const { values } = parse(args, { ...ENGAGEMENT_OPTION }, 0);
    const l = resolveEngagement(radrHome(ctx.env), values.engagement, ctx.env, ctx.cwd);
    const events = new EventLog(l.events, ctx.clock).read();
    ctx.out(`engagement ${l.id}`);
    try {
      const doc = loadEngagement(l.engagementYml);
      const fp = scopeFingerprint(readScopeInputs(l));
      const g = Gates.load().evaluate("scope", events, { fingerprint: fp });
      ctx.out(`  scope:   ${doc.engagement_type} / ${doc.tier} at ${doc.source.sha.slice(0, 12)} (${doc.lanes.join(", ")})`);
      ctx.out(`  gate 1:  ${g.passed ? "approved" : `closed: ${g.reason}`}`);
    } catch (e) {
      if (!(e instanceof UsageError || e instanceof RefusedError)) throw e;
      ctx.out(`  scope:   not proposed yet (${e.message})`);
    }
    const lastRun = events.findLast((e) => e.type === "run-completed");
    if (lastRun === undefined) {
      ctx.out("  runs:    none");
      return;
    }
    const runId = String(lastRun.data["run_id"]);
    ctx.out(`  last run ${runId}: ${String(lastRun.data["status"])}`);
    for (const e of events.filter((x) => x.type === "lane-completed" && x.data["run_id"] === runId && x.data["action"] !== "retry")) {
      ctx.out(`    ${String(e.data["lane"]).padEnd(8)} ${String(e.data["outcome"])}`);
    }
    const { findings: present } = latestRunFindings(l.findings);
    const states = dispositions(events);
    const bySev = SEVERITIES.slice().reverse().map((s) => `${s}=${present.filter((f) => f.severity === s).length}`).join(" ");
    const byState = ["pending", "confirmed", "dismissed", "waived"].map((s) => `${s}=${present.filter((f) => stateOf(states, f.id) === s).length}`).join(" ");
    ctx.out(`  findings ${present.length}: ${bySev}`);
    ctx.out(`  states:  ${byState}`);
  },
};
