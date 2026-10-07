// LLM-lane commands (M4): triage (policy permitting) and severity (a consultant's override of a
// judgment finding's rubric severity).

import { resolveActor } from "../../core/actor.js";
import { RefusedError, UsageError } from "../../core/errors.js";
import { loadRunInputs } from "../../address/inputs.js";
import { radrHome, resolveEngagement } from "../../engagement/home.js";
import { readJudgments, severityOverrides } from "../../findings/judgments.js";
import { SEVERITIES, type Severity } from "../../findings/types.js";
import { triage } from "../../llm/triage.js";
import { Matrix } from "../../matrix/matrix.js";
import { assertScope } from "../../review/run.js";
import { EventLog } from "../../state/events.js";
import { Gates } from "../../state/gates.js";
import { ENGAGEMENT_OPTION, parse } from "../args.js";
import type { CommandSpec } from "../context.js";

export const triageCmd: CommandSpec = {
  name: "triage",
  usage: "radr triage [-e <id>]",
  summary: "LLM lane: explain, cluster, and propose (llm_policy permitting)",
  async run(args, ctx) {
    const { values } = parse(args, { ...ENGAGEMENT_OPTION }, 0);
    const l = resolveEngagement(radrHome(ctx.env), values.engagement, ctx.env, ctx.cwd);
    const log = new EventLog(l.events, ctx.clock);
    // The LLM reads the worktree (code-allowed snippets, anchor checks): same gate as a lane.
    const { doc } = await assertScope(l, Gates.load(), log);
    if (doc.llm_policy === "off") throw new RefusedError(`llm_policy is "off" for ${l.id}; set it in engagement.yml and re-approve the scope to use triage`);
    const inp = loadRunInputs(l, ctx.clock);
    if (inp.runStatus === "aborted") throw new RefusedError(`run ${inp.runId} was aborted; fix it and re-run \`radr review\``);
    const r = await triage({
      layout: l, doc, rubric: inp.rubric, runId: inp.runId, findings: inp.findings,
      env: ctx.env, log, actor: await resolveActor(ctx.env), matrix: Matrix.load(),
    });
    ctx.out(`triage ${l.id} (run ${inp.runId}, policy ${doc.llm_policy}): ${r.status}; ${String(r.batches)} batch(es), ${String(r.calls)} agent call(s)`);
    ctx.out(`  explanations ${String(r.explanations)}, clusters ${String(r.clusters)}, proposed dispositions ${String(r.proposals)}`);
    ctx.out(`  judgment findings proposed ${String(r.judgments)}${r.duplicates > 0 ? ` (${String(r.duplicates)} already proposed)` : ""}, rejected items ${String(r.rejected)}`);
    if (r.batches === 0) ctx.out("  nothing to triage: the run has no findings");
    if (r.judgments > 0) ctx.out(`review proposed judgments: radr findings -e ${l.id} --state proposed; accept with \`radr disposition <J-id> pending\``);
    if (r.status === "partial") ctx.out("some batches failed (see llm-call events); re-run `radr triage` to retry them");
    if (r.status === "aborted") throw new RefusedError("triage aborted: the agent command is missing (see the llm-call event)");
  },
};

export const severity: CommandSpec = {
  name: "severity",
  usage: "radr severity <J-id> <severity> --reason <text> [-e <id>]",
  summary: "override a judgment finding's rubric severity (recorded, with reason)",
  async run(args, ctx) {
    const { values, positionals } = parse(args, { ...ENGAGEMENT_OPTION, reason: { type: "string" } }, 2);
    const [id = "", to = ""] = positionals;
    if (!SEVERITIES.includes(to as Severity)) throw new UsageError(`unknown severity "${to}" (${SEVERITIES.join(", ")})`);
    if (!id.startsWith("J-")) throw new RefusedError(`${id}: tool-finding severity comes from the rubric only; overrides apply to judgment findings (J-…)`);
    const reason = values.reason;
    if (reason === undefined || reason.trim() === "") throw new RefusedError("a severity override requires --reason");
    const l = resolveEngagement(radrHome(ctx.env), values.engagement, ctx.env, ctx.cwd);
    const j = readJudgments(l.judgments).find((x) => x.id === id);
    if (j === undefined) throw new UsageError(`no judgment finding ${id} in ${l.id}`);
    const log = new EventLog(l.events, ctx.clock);
    const from = severityOverrides(log.read()).get(id) ?? j.severity;
    if (from === to) throw new RefusedError(`${id} is already ${to}`);
    log.append("severity-override", await resolveActor(ctx.env), { finding_id: id, from, to, reason });
    ctx.out(`${id}: severity ${from} → ${to}`);
  },
};
