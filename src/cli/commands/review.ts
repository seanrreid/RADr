// Review commands: review, findings, disposition, status.

import { resolveActor } from "../../core/actor.js";
import { readFileSync } from "node:fs";
import { canonicalJson, hashBytes, stableSort } from "../../core/determinism.js";
import { matchesAny } from "../../core/glob.js";
import { RefusedError, UsageError } from "../../core/errors.js";
import { loadEngagement } from "../../engagement/config.js";
import { radrHome, resolveEngagement } from "../../engagement/home.js";
import { checkTransition, dispositions, isState, stateOf } from "../../findings/disposition.js";
import { readJudgments, runJudgments } from "../../findings/judgments.js";
import { findingsSetHash, latestRunFindings, readStore } from "../../findings/store.js";
import { readAnnotations, type Annotation } from "../../llm/triage.js";
import { SEVERITIES, type Finding } from "../../findings/types.js";
import { assertScope, review as runReview } from "../../review/run.js";
import { draftKeeps } from "../../llm/draft.js";
import { llmMetrics } from "../../state/llm-metrics.js";
import { Matrix } from "../../matrix/matrix.js";
import { computeScorecard } from "../../address/scorecard.js";
import { loadRunInputs } from "../../address/inputs.js";
import { writeAddress } from "../../address/report.js";
import { render } from "../../address/render.js";
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
    const r = await runReview(home, l, await resolveActor(ctx.env), ctx.clock, ctx.env);
    ctx.out(`run ${r.runId}: ${r.status}`);
    for (const s of r.lanes) {
      ctx.out(`  ${s.lane.padEnd(8)} ${s.outcome.padEnd(14)} ${s.action.padEnd(9)} findings=${s.findings}${s.attempts > 1 ? ` attempts=${s.attempts}` : ""}`);
      if (s.detail !== undefined && s.outcome !== "success") ctx.out(`           ${s.detail}`);
    }
    if (r.setHash !== null) ctx.out(`findings: ${r.findings} present (${r.added} new); set ${r.setHash}`);
    if ((r.autoConfirmed ?? 0) > 0) ctx.out(`auto-confirmed by rubric: ${r.autoConfirmed ?? 0} (the review set always needs you)`);
    for (const n of r.notes ?? []) ctx.out(`note: ${n}`);
    for (const o of r.outputs ?? []) ctx.out(`pr output: ${o}`);
    if (r.status === "aborted") throw new RefusedError(`run ${r.runId} aborted (see lane outcomes above)`);
  },
};

function printFinding(ctx: CliContext, f: Finding, state: string, notes: readonly Annotation[] = []): void {
  const loc = f.line > 0 ? `${f.file}:${f.line}` : f.file;
  const source = f.class === "judgment" ? "judgment (LLM-proposed)" : `${f.tool}/${f.rule_id}`;
  ctx.out(`${f.id}  ${f.severity.padEnd(8)} ${state.padEnd(9)} ${f.lane.padEnd(7)} ${source}  ${loc}`);
  ctx.out(`        ${f.message}`);
  // LLM annotations are labelled and display-only (M4): proposals, never decisions.
  for (const n of notes) {
    if (n.type === "explanation") ctx.out(`        [LLM] ${n.text}`);
    else if (n.type === "disposition-proposal") ctx.out(`        [LLM proposes ${n.proposed}] ${n.reason}`);
    else if (n.type === "cluster") ctx.out(`        [LLM cluster ${n.finding_ids.join(", ")}] ${n.rationale}`);
  }
}

/** Annotations per finding id (clusters listed under each member). */
function notesById(notes: readonly Annotation[]): Map<string, Annotation[]> {
  const out = new Map<string, Annotation[]>();
  const add = (id: string, n: Annotation) => out.set(id, [...(out.get(id) ?? []), n]);
  for (const n of notes) {
    if (n.type === "cluster") for (const id of n.finding_ids) add(id, n);
    else if (n.type !== "rejected") add(n.finding_id, n);
  }
  return out;
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
    const events = new EventLog(l.events, ctx.clock).read();
    const states = dispositions(events);
    const judged = runId === null ? [] : runJudgments(l.judgments, runId, events);
    const selected = stableSort(
      [...present, ...judged].filter((f) =>
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
    const notes = notesById(readAnnotations(l, runId));
    for (const f of selected) printFinding(ctx, f, stateOf(states, f.id), notes.get(f.id));
    ctx.out(`${selected.length} of ${present.length + judged.length} findings (run ${runId}${judged.length > 0 ? `; ${String(judged.length)} judgment` : ""})`);
  },
};

export const disposition: CommandSpec = {
  name: "disposition",
  usage: "radr disposition <F-id> <state> | --rule|--category|--lane|--path <sel> <state> --reason <text> [-e <id>]",
  summary: "record a consultant decision on one finding, or in bulk",
  async run(args, ctx) {
    const { values, positionals } = parse(args, {
      ...ENGAGEMENT_OPTION, reason: { type: "string" },
      rule: { type: "string" }, category: { type: "string" }, lane: { type: "string" }, path: { type: "string" },
    }, [1, 2]);
    const bulk = values.rule !== undefined || values.category !== undefined || values.lane !== undefined || values.path !== undefined;
    if (bulk !== (positionals.length === 1)) throw new UsageError("use either `<F-id> <state>` or a selector (--rule/--category/--lane/--path) with `<state>`");
    const to = positionals.at(-1) ?? "";
    if (!isState(to)) throw new UsageError(`unknown state "${to}"`);
    const l = resolveEngagement(radrHome(ctx.env), values.engagement, ctx.env, ctx.cwd);
    const log = new EventLog(l.events, ctx.clock);
    const states = dispositions(log.read());
    const actor = await resolveActor(ctx.env);
    const reason = values.reason;

    if (!bulk) {
      const id = positionals[0] ?? "";
      const known = id.startsWith("J-") ? readJudgments(l.judgments).some((j) => j.id === id) : readStore(l.findings).findings.some((f) => f.id === id);
      if (!known) throw new UsageError(`no finding ${id} in ${l.id}`);
      const from = stateOf(states, id);
      checkTransition(from, to, reason, id);
      log.append("finding-disposition", actor, { finding_id: id, from, to, ...(reason !== undefined ? { reason } : {}) });
      ctx.out(`${id}: ${from} → ${to}`);
      return;
    }

    // Bulk (M2 AC4): one event per finding, all sharing a mandatory reason.
    if (reason === undefined || reason.trim() === "") throw new RefusedError("bulk disposition requires --reason");
    const matched = latestRunFindings(l.findings).findings.filter((f) =>
      (values.rule === undefined || f.rule_id === values.rule) &&
      (values.category === undefined || f.category === values.category) &&
      (values.lane === undefined || f.lane === values.lane) &&
      (values.path === undefined || matchesAny(f.file, [values.path])));
    if (matched.length === 0) throw new RefusedError("selector matched no findings in the latest run");
    let applied = 0;
    const skipped: string[] = [];
    for (const f of stableSort(matched, (x) => x.id)) {
      const from = stateOf(states, f.id);
      try {
        checkTransition(from, to, reason);
      } catch (e) {
        if (!(e instanceof RefusedError)) throw e;
        skipped.push(`${f.id} (${from})`);
        continue;
      }
      log.append("finding-disposition", actor, { finding_id: f.id, from, to, reason });
      applied++;
    }
    if (applied === 0) throw new RefusedError(`no matched finding can move to ${to}: ${skipped.join(", ")}`);
    ctx.out(`${applied} finding(s) → ${to}${skipped.length > 0 ? `; skipped ${skipped.length}: ${skipped.join(", ")}` : ""}`);
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
    const judged = runJudgments(l.judgments, runId, events);
    if (judged.length > 0) {
      const jStates = ["proposed", "pending", "confirmed", "dismissed", "waived"].map((s) => `${s}=${judged.filter((j) => stateOf(states, j.id) === s).length}`).join(" ");
      ctx.out(`  judgment ${judged.length}: ${jStates}`);
    }
    const m = llmMetrics(events);
    if (m.calls > 0) {
      ctx.out(`  llm:     ${String(m.calls)} call(s), ${String(m.succeeded)} valid, ${String(m.failProtocol)} fail-protocol; judgments proposed ${String(m.judgmentsProposed)}, kept ${String(m.judgmentsKept)}, dismissed ${String(m.judgmentsDismissed)}`);
    }
  },
};

export const scorecard: CommandSpec = {
  name: "scorecard",
  usage: "radr scorecard [-e <id>] [--json]",
  summary: "triage scorecard for the latest run (rubric v1+)",
  run(args, ctx) {
    const { values } = parse(args, { ...ENGAGEMENT_OPTION, json: { type: "boolean" } }, 0);
    const l = resolveEngagement(radrHome(ctx.env), values.engagement, ctx.env, ctx.cwd);
    const inp = loadRunInputs(l, ctx.clock);
    if (inp.rubric.scorecard === undefined) throw new RefusedError(`rubric ${inp.rubric.version} has no scorecard (use rubric v1 or later)`);
    const card = computeScorecard(inp.rubric.scorecard, inp);
    if (values.json === true) {
      ctx.out(canonicalJson({ run_id: inp.runId, verdict: card.verdict, rows: card.rows.map((r) => ({ ...r })) }));
      return;
    }
    ctx.out(`scorecard ${l.id} (run ${inp.runId}): ${card.verdict.toUpperCase()}`);
    for (const r of card.rows) ctx.out(`  ${r.rating.padEnd(6)} ${r.label.padEnd(54)} ${r.value === null ? "unavailable" : String(r.value)}`);
  },
};

export const address: CommandSpec = {
  name: "address",
  usage: "radr address [-e <id>] [--draft]",
  summary: "generate report.md + remediation.md; --draft: LLM drafts of untouched prose blocks",
  async run(args, ctx) {
    const { values } = parse(args, { ...ENGAGEMENT_OPTION, draft: { type: "boolean" } }, 0);
    const l = resolveEngagement(radrHome(ctx.env), values.engagement, ctx.env, ctx.cwd);
    const log = new EventLog(l.events, ctx.clock);
    const actor = await resolveActor(ctx.env);
    // --draft reads the worktree (code-allowed context): the same gate as a lane, checked first.
    const doc = values.draft === true ? (await assertScope(l, Gates.load(), log)).doc : undefined;
    if (doc?.llm_policy === "off") throw new RefusedError(`llm_policy is "off" for ${l.id}; --draft needs metadata-only or code-allowed`);
    const inp = loadRunInputs(l, ctx.clock);
    if (inp.runStatus === "aborted") throw new RefusedError(`run ${inp.runId} was aborted; fix it and re-run \`radr review\``);
    const r = writeAddress(inp, l);
    let hashes = { report: r.reportHash, remediation: r.remediationHash };
    if (doc !== undefined) {
      const d = await draftKeeps(l, inp, { policy: doc.llm_policy, env: ctx.env, llmDir: l.llm, log, actor, matrix: Matrix.load() });
      hashes = { report: hashBytes(readFileSync(r.paths.report)), remediation: hashBytes(readFileSync(r.paths.remediation)) };
      ctx.out(`draft: ${d.status}${d.drafted.length > 0 ? `; drafted ${d.drafted.join(", ")}` : ""}${d.kept.length > 0 ? `; kept your text in ${d.kept.join(", ")}` : ""}${d.rejected.length > 0 ? `; rejected ${d.rejected.join(", ")}` : ""}`);
      if (d.status === "aborted") throw new RefusedError("drafting aborted: the agent command is missing (see the llm-call event)");
    }
    log.append("report-generated", actor, {
      run_id: inp.runId, findings_set_hash: r.setHash, report_hash: hashes.report, remediation_hash: hashes.remediation,
    });
    ctx.out(`report: ${r.paths.report}`);
    ctx.out(`plan:   ${r.paths.remediation} (${String(r.items)} work items)`);
    ctx.out(`edit the keep-blocks (executive summary, recommendations, plan notes${values.draft === true ? "; delete each draft marker once reviewed" : ""}), then: radr approve report -e ${l.id}`);
  },
};

export const renderCmd: CommandSpec = {
  name: "render",
  usage: "radr render [-e <id>]",
  summary: "PDF of the approved report and plan (requires Gate 2)",
  async run(args, ctx) {
    const { values } = parse(args, { ...ENGAGEMENT_OPTION }, 0);
    const home = radrHome(ctx.env);
    const l = resolveEngagement(home, values.engagement, ctx.env, ctx.cwd);
    const r = await render(home, l, ctx.clock);
    for (const p of r.pdfs) ctx.out(`${p.path}\n  ${p.hash}`);
  },
};
