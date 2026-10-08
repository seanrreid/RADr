// `radr debug` (PRD §11, M5): the root-cause workflow. Subcommands record events; the gates
// in src/debug/state.ts decide what may happen next.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { resolveActor } from "../../core/actor.js";
import { RefusedError, UsageError } from "../../core/errors.js";
import { bisect } from "../../debug/bisect.js";
import { debugSandbox, runDebugScript, scriptHash } from "../../debug/sandbox.js";
import { gitOut } from "../../engagement/git.js";
import { guard } from "../../debug/guard.js";
import { writeRootCause } from "../../debug/report.js";
import { assertCanConclude, assertCanDecide, assertOpen, getDebug, debugStates, nextId, reproducing, type DebugState } from "../../debug/state.js";
import { resolveSha } from "../../engagement/source.js";
import { suggest } from "../../llm/debug-suggest.js";
import { secretFiles } from "../../llm/redact.js";
import { Matrix } from "../../matrix/matrix.js";
import { radrHome, resolveEngagement, type Layout } from "../../engagement/home.js";
import { readJudgments } from "../../findings/judgments.js";
import { readStore } from "../../findings/store.js";
import { assertScope, snapshotsFor } from "../../review/run.js";
import { EventLog } from "../../state/events.js";
import { Gates } from "../../state/gates.js";
import { ENGAGEMENT_OPTION, parse } from "../args.js";
import type { CliContext, CommandSpec } from "../context.js";

const SUBCOMMANDS = ["open", "list", "show", "repro", "bisect", "propose", "experiment", "decide", "conclude", "report", "guard", "suggest"] as const;

/** debug/<id>/ and its evidence folders. */
export function debugDir(l: Layout, id: string): { root: string; repro: string; experiments: string; guard: string; runs: string } {
  const root = path.join(l.debug, id);
  return { root, repro: path.join(root, "repro"), experiments: path.join(root, "experiments"), guard: path.join(root, "guard"), runs: path.join(root, "runs") };
}

async function open(args: readonly string[], ctx: CliContext): Promise<void> {
  const { values } = parse(args, {
    ...ENGAGEMENT_OPTION, "from-finding": { type: "string" }, issue: { type: "string" },
    expected: { type: "string" }, actual: { type: "string" }, environment: { type: "string" }, "first-seen": { type: "string" },
  }, 0);
  const finding = values["from-finding"];
  if ((finding === undefined) === (values.issue === undefined)) throw new UsageError("give exactly one of --from-finding <F-id|J-id> or --issue \"<symptom>\"");
  const l = resolveEngagement(radrHome(ctx.env), values.engagement, ctx.env, ctx.cwd);
  const log = new EventLog(l.events, ctx.clock);
  // Debug runs client code: always behind an approved scope (PRD §11).
  const { doc } = await assertScope(l, Gates.load(), log);
  let symptom = values.issue ?? "";
  if (finding !== undefined) {
    const f = finding.startsWith("J-") ? readJudgments(l.judgments).find((j) => j.id === finding) : readStore(l.findings).findings.find((x) => x.id === finding);
    if (f === undefined) throw new UsageError(`no finding ${finding} in ${l.id}`);
    symptom = `${f.id} ${f.tool}/${f.rule_id} at ${f.line > 0 ? `${f.file}:${String(f.line)}` : f.file}: ${f.message}`;
  }
  if (symptom.trim() === "") throw new UsageError("the symptom can't be empty");
  const events = log.read();
  const id = nextId(events, "D");
  const opt = (k: string, v: string | undefined) => (v === undefined || v.trim() === "" ? {} : { [k]: v });
  log.append("debug-opened", await resolveActor(ctx.env), {
    debug_id: id, from: finding === undefined ? "issue" : "finding", ...opt("finding_id", finding), symptom, commit: doc.source.sha,
    ...opt("expected", values.expected), ...opt("actual", values.actual), ...opt("environment", values.environment), ...opt("first_seen", values["first-seen"]),
  });
  const dirs = debugDir(l, id);
  for (const d of [dirs.repro, dirs.experiments, dirs.guard, dirs.runs]) mkdirSync(d, { recursive: true });
  ctx.out(`opened ${id} at ${doc.source.sha.slice(0, 12)}: ${symptom}`);
  ctx.out(`next: write ${path.join(dirs.repro, "repro.sh")} (exit 0 = bug absent, 125 = can't tell, other non-zero = bug present), then: radr debug repro ${id}`);
}

async function repro(args: readonly string[], ctx: CliContext): Promise<void> {
  const { values, positionals } = parse(args, { ...ENGAGEMENT_OPTION, stack: { type: "string" } }, 1);
  const home = radrHome(ctx.env);
  const l = resolveEngagement(home, values.engagement, ctx.env, ctx.cwd);
  const log = new EventLog(l.events, ctx.clock);
  const { doc } = await assertScope(l, Gates.load(), log);
  const d = getDebug(log.read(), positionals[0] ?? "");
  assertOpen(d);
  if (d.commit !== doc.source.sha) throw new RefusedError(`${d.id} was opened at ${d.commit.slice(0, 12)}, but the approved scope is now at ${doc.source.sha.slice(0, 12)}; open a new debug`);
  const script = path.join(debugDir(l, d.id).repro, "repro.sh");
  // Once the repro has reproduced, it's evidence other runs (bisect, guard) rely on: frozen.
  const reproduced = reproducing(d)[0];
  if (reproduced !== undefined && reproduced.scriptHash !== scriptHash(script)) {
    throw new RefusedError(`repro.sh changed after it reproduced the bug (${reproduced.runId}); restore it, or open a new debug for a different repro`);
  }
  const sb = await debugSandbox(home, l, doc, ctx.env, snapshotsFor(home, l).depsCache, values.stack);
  const r = await runDebugScript(l, log, await resolveActor(ctx.env), sb, { debugId: d.id, kind: "repro", commit: d.commit, worktree: l.worktree, script });
  ctx.out(`${r.runId}: repro at ${d.commit.slice(0, 12)} exited ${String(r.exitCode)} → ${r.outcome === "present" ? "bug present (reproduced)" : r.outcome === "absent" ? "bug absent (not reproduced)" : r.outcome}`);
  ctx.out(`  log: ${r.logRef}`);
}

async function bisectCmd(args: readonly string[], ctx: CliContext): Promise<void> {
  const { values, positionals } = parse(args, { ...ENGAGEMENT_OPTION, good: { type: "string" }, stack: { type: "string" } }, 1);
  if (values.good === undefined) throw new UsageError("bisect needs --good <rev>: a commit where the bug is absent");
  const home = radrHome(ctx.env);
  const l = resolveEngagement(home, values.engagement, ctx.env, ctx.cwd);
  const log = new EventLog(l.events, ctx.clock);
  const { doc } = await assertScope(l, Gates.load(), log);
  const d = getDebug(log.read(), positionals[0] ?? "");
  const sb = await debugSandbox(home, l, doc, ctx.env, snapshotsFor(home, l).depsCache, values.stack);
  const r = await bisect(l, log, await resolveActor(ctx.env), sb, d, values.good, path.join(debugDir(l, d.id).repro, "repro.sh"));
  ctx.out(`bisect ${d.id}: ${String(r.runs.length)} sandbox run(s) between ${r.good.slice(0, 12)} (good) and ${r.bad.slice(0, 12)} (bad)`);
  if (r.firstBad.length === 1) {
    const sha = r.firstBad[0] ?? "";
    ctx.out(`  first bad commit: ${sha} ${await gitOut(["log", "-1", "--format=%s", sha], l.mirror)}`);
  } else {
    ctx.out(`  some commits couldn't be tested (skipped); the first bad commit is one of:`);
    for (const sha of r.firstBad) ctx.out(`    ${sha}`);
  }
}

async function propose(args: readonly string[], ctx: CliContext): Promise<void> {
  const { values, positionals } = parse(args, { ...ENGAGEMENT_OPTION }, 2);
  const [id = "", text = ""] = positionals;
  if (text.trim() === "") throw new UsageError("the hypothesis can't be empty");
  const l = resolveEngagement(radrHome(ctx.env), values.engagement, ctx.env, ctx.cwd);
  const log = new EventLog(l.events, ctx.clock);
  const events = log.read();
  const d = getDebug(events, id);
  assertOpen(d);
  const hid = nextId(events, "H");
  log.append("hypothesis-proposed", await resolveActor(ctx.env), { debug_id: d.id, hypothesis_id: hid, text: text.trim(), source: "consultant" });
  ctx.out(`${hid} proposed for ${d.id}: ${text.trim()}`);
  ctx.out(`test it: write ${path.join(debugDir(l, d.id).experiments, "<name>.sh")}, then radr debug experiment ${d.id} --hypothesis ${hid} <name>.sh`);
}

async function experiment(args: readonly string[], ctx: CliContext): Promise<void> {
  const { values, positionals } = parse(args, { ...ENGAGEMENT_OPTION, hypothesis: { type: "string" }, stack: { type: "string" } }, 2);
  const [id = "", name = ""] = positionals;
  if (values.hypothesis === undefined) throw new UsageError("an experiment tests a hypothesis: --hypothesis <H-id>");
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new UsageError(`"${name}" isn't a script name in the debug's experiments/ folder`);
  const home = radrHome(ctx.env);
  const l = resolveEngagement(home, values.engagement, ctx.env, ctx.cwd);
  const log = new EventLog(l.events, ctx.clock);
  const { doc } = await assertScope(l, Gates.load(), log);
  const d = getDebug(log.read(), id);
  assertOpen(d);
  if (!d.hypotheses.some((h) => h.id === values.hypothesis && h.state === "proposed")) throw new RefusedError(`${values.hypothesis} is not an undecided hypothesis of ${d.id}`);
  const sb = await debugSandbox(home, l, doc, ctx.env, snapshotsFor(home, l).depsCache, values.stack);
  const r = await runDebugScript(l, log, await resolveActor(ctx.env), sb, {
    debugId: d.id, kind: "experiment", commit: d.commit, worktree: l.worktree, script: path.join(debugDir(l, d.id).experiments, name), hypothesisId: values.hypothesis,
  });
  ctx.out(`${r.runId}: experiment ${name} for ${values.hypothesis} exited ${String(r.exitCode)} (${r.outcome}); log ${r.logRef}`);
  ctx.out(`decide with it: radr debug decide ${d.id} ${values.hypothesis} confirmed|refuted --run ${r.runId} --reason "…"`);
}

async function decide(args: readonly string[], ctx: CliContext): Promise<void> {
  const { values, positionals } = parse(args, { ...ENGAGEMENT_OPTION, run: { type: "string" }, reason: { type: "string" } }, 3);
  const [id = "", hid = "", to = ""] = positionals;
  if (to !== "confirmed" && to !== "refuted") throw new UsageError(`a hypothesis is confirmed or refuted, not "${to}"`);
  if (values.run === undefined) throw new UsageError("cite the experiment run that decides it: --run <DR-id>");
  if (values.reason === undefined || values.reason.trim() === "") throw new UsageError("a decision needs --reason");
  const l = resolveEngagement(radrHome(ctx.env), values.engagement, ctx.env, ctx.cwd);
  const log = new EventLog(l.events, ctx.clock);
  const d = getDebug(log.read(), id);
  assertCanDecide(d, hid, to, values.run);
  log.append("hypothesis-decided", await resolveActor(ctx.env), { debug_id: d.id, hypothesis_id: hid, to, run_id: values.run, reason: values.reason.trim() });
  ctx.out(`${hid}: ${to} (by ${values.run})`);
}

async function conclude(args: readonly string[], ctx: CliContext): Promise<void> {
  const { values, positionals } = parse(args, { ...ENGAGEMENT_OPTION, hypothesis: { type: "string" }, summary: { type: "string" }, commit: { type: "string" }, "to-plan": { type: "boolean" } }, 2);
  const [id = "", outcome = ""] = positionals;
  if (outcome !== "root-caused" && outcome !== "cannot-reproduce") throw new UsageError(`a debug concludes root-caused or cannot-reproduce, not "${outcome}"`);
  if (values.summary === undefined || values.summary.trim() === "") throw new UsageError("a conclusion needs --summary");
  const l = resolveEngagement(radrHome(ctx.env), values.engagement, ctx.env, ctx.cwd);
  const log = new EventLog(l.events, ctx.clock);
  const d = getDebug(log.read(), id);
  assertCanConclude(d, outcome, values.hypothesis);
  // The introducing commit: given, else the bisect's single first-bad commit.
  let introducing: string | undefined;
  if (values.commit !== undefined) introducing = await resolveSha(l.mirror, values.commit);
  else if (outcome === "root-caused" && d.bisect?.firstBad.length === 1) introducing = d.bisect.firstBad[0];
  log.append("debug-concluded", await resolveActor(ctx.env), {
    debug_id: d.id, outcome, summary: values.summary.trim(),
    ...(outcome === "root-caused" && values.hypothesis !== undefined ? { hypothesis_id: values.hypothesis } : {}),
    ...(introducing !== undefined ? { introducing_commit: introducing } : {}),
    ...(values["to-plan"] === true && outcome === "root-caused" ? { to_plan: true } : {}),
  });
  const file = path.join(debugDir(l, d.id).root, "root-cause.md");
  writeRootCause(file, getDebug(log.read(), d.id), l.id);
  ctx.out(`${d.id} concluded ${outcome}${introducing !== undefined ? ` (introduced by ${introducing.slice(0, 12)})` : ""}`);
  ctx.out(`  record: ${file}`);
}

async function guardCmd(args: readonly string[], ctx: CliContext): Promise<void> {
  const { values, positionals } = parse(args, { ...ENGAGEMENT_OPTION, "fix-commit": { type: "string" }, stack: { type: "string" } }, 1);
  const home = radrHome(ctx.env);
  const l = resolveEngagement(home, values.engagement, ctx.env, ctx.cwd);
  const log = new EventLog(l.events, ctx.clock);
  const { doc } = await assertScope(l, Gates.load(), log);
  const d = getDebug(log.read(), positionals[0] ?? "");
  const fix = values["fix-commit"] === undefined ? undefined : await resolveSha(l.mirror, values["fix-commit"]);
  const sb = await debugSandbox(home, l, doc, ctx.env, snapshotsFor(home, l).depsCache, values.stack);
  const g = await guard(l, log, await resolveActor(ctx.env), sb, d, debugDir(l, d.id).guard, fix);
  ctx.out(`${g.withoutFix.runId}: without the fix → ${g.withoutFix.outcome === "present" ? "test fails (good)" : `test ${g.withoutFix.outcome === "absent" ? "passes" : g.withoutFix.outcome} (it must fail)`}`);
  ctx.out(`${g.withFix.runId}: with the fix    → ${g.withFix.outcome === "absent" ? "test passes (good)" : `test ${g.withFix.outcome === "present" ? "fails" : g.withFix.outcome} (it must pass)`}`);
  writeRootCause(path.join(debugDir(l, d.id).root, "root-cause.md"), getDebug(log.read(), d.id), l.id);
  if (!g.holds) throw new RefusedError(`the regression guard does not hold for ${d.id}: the test must fail without the fix and pass with it`);
  ctx.out(`guard holds; deliver ${path.join(debugDir(l, d.id).guard, "test.patch")}`);
}

async function suggestCmd(args: readonly string[], ctx: CliContext): Promise<void> {
  const { values, positionals } = parse(args, { ...ENGAGEMENT_OPTION }, 1);
  const l = resolveEngagement(radrHome(ctx.env), values.engagement, ctx.env, ctx.cwd);
  const log = new EventLog(l.events, ctx.clock);
  const { doc } = await assertScope(l, Gates.load(), log);
  if (doc.llm_policy === "off") throw new RefusedError(`llm_policy is "off" for ${l.id}; suggestions need metadata-only or code-allowed`);
  const d = getDebug(log.read(), positionals[0] ?? "");
  const f = d.findingId === undefined ? undefined
    : d.findingId.startsWith("J-") ? readJudgments(l.judgments).find((j) => j.id === d.findingId) : readStore(l.findings).findings.find((x) => x.id === d.findingId);
  const actor = await resolveActor(ctx.env);
  const noCode = secretFiles(readStore(l.findings).findings);
  const r = await suggest(l, log, actor, { policy: doc.llm_policy, env: ctx.env, llmDir: l.llm, log, actor, matrix: Matrix.load() }, d, f, noCode);
  ctx.out(`suggest ${d.id}: ${r.status}; proposed ${r.proposed.length > 0 ? r.proposed.join(", ") : "nothing"}${r.rejected > 0 ? `; rejected ${String(r.rejected)}` : ""}`);
  if (r.proposed.length > 0) ctx.out(`these are [LLM] proposals: test each with radr debug experiment ${d.id} --hypothesis <H-id> <script>`);
  if (r.status === "aborted") throw new RefusedError("suggest aborted: the agent command is missing (see the llm-call event)");
}

function report(args: readonly string[], ctx: CliContext): void {
  const { values, positionals } = parse(args, { ...ENGAGEMENT_OPTION }, 1);
  const l = resolveEngagement(radrHome(ctx.env), values.engagement, ctx.env, ctx.cwd);
  const d = getDebug(new EventLog(l.events, ctx.clock).read(), positionals[0] ?? "");
  const file = path.join(debugDir(l, d.id).root, "root-cause.md");
  writeRootCause(file, d, l.id);
  ctx.out(file);
}

function list(args: readonly string[], ctx: CliContext): void {
  const { values } = parse(args, { ...ENGAGEMENT_OPTION }, 0);
  const l = resolveEngagement(radrHome(ctx.env), values.engagement, ctx.env, ctx.cwd);
  const all = [...debugStates(new EventLog(l.events, ctx.clock).read()).values()];
  if (all.length === 0) {
    ctx.out("no debugs yet (radr debug open)");
    return;
  }
  for (const d of all) ctx.out(`${d.id}  ${phase(d).padEnd(16)} ${d.symptom}`);
}

/** Where the method stands: the next gate to pass. */
export function phase(d: DebugState): string {
  if (d.conclusion !== undefined) return d.conclusion.outcome;
  if (reproducing(d).length === 0) return d.runs.some((r) => r.kind === "repro") ? "not reproduced" : "intake";
  if (d.hypotheses.some((h) => h.state === "confirmed")) return "ready to conclude";
  return "reproduced";
}

function show(args: readonly string[], ctx: CliContext): void {
  const { values, positionals } = parse(args, { ...ENGAGEMENT_OPTION }, 1);
  const l = resolveEngagement(radrHome(ctx.env), values.engagement, ctx.env, ctx.cwd);
  const d = getDebug(new EventLog(l.events, ctx.clock).read(), positionals[0] ?? "");
  ctx.out(`${d.id} (${phase(d)}) at ${d.commit.slice(0, 12)}${d.findingId !== undefined ? `, from ${d.findingId}` : ""}`);
  ctx.out(`  symptom:  ${d.symptom}`);
  for (const [k, v] of [["expected", d.expected], ["actual", d.actual], ["environment", d.environment], ["first seen", d.firstSeen]] as const) {
    if (v !== undefined) ctx.out(`  ${`${k}:`.padEnd(9)} ${v}`);
  }
  for (const r of d.runs) ctx.out(`  ${r.runId}  ${r.kind.padEnd(17)} ${r.commit.slice(0, 12)}  exit ${String(r.exitCode)} → ${r.outcome}${r.hypothesisId !== undefined ? ` (${r.hypothesisId})` : ""}  ${r.logRef}`);
  if (d.bisect !== undefined) ctx.out(`  bisect: ${d.bisect.firstBad.length === 1 ? `first bad ${d.bisect.firstBad[0] ?? ""}` : `first bad is one of ${d.bisect.firstBad.map((c) => c.slice(0, 12)).join(", ")}`}`);
  for (const h of d.hypotheses) ctx.out(`  ${h.id}  ${h.state.padEnd(9)} ${h.source === "llm" ? "[LLM] " : ""}${h.text}${h.decidedBy !== undefined ? ` (by ${h.decidedBy}: ${h.reason ?? ""})` : ""}`);
  if (d.conclusion !== undefined) ctx.out(`  concluded ${d.conclusion.outcome}: ${d.conclusion.summary}`);
}

export const debug: CommandSpec = {
  name: "debug",
  usage: `radr debug ${SUBCOMMANDS.join("|")} … [-e <id>]`,
  summary: "root-cause workflow: intake, repro, bisect, hypotheses, conclusion",
  async run(args, ctx) {
    const [sub, ...rest] = args;
    switch (sub) {
      case "open": return open(rest, ctx);
      case "list":
        list(rest, ctx);
        return;
      case "show":
        show(rest, ctx);
        return;
      case "repro": return repro(rest, ctx);
      case "bisect": return bisectCmd(rest, ctx);
      case "propose": return propose(rest, ctx);
      case "experiment": return experiment(rest, ctx);
      case "decide": return decide(rest, ctx);
      case "conclude": return conclude(rest, ctx);
      case "guard": return guardCmd(rest, ctx);
      case "suggest": return suggestCmd(rest, ctx);
      case "report":
        report(rest, ctx);
        return;
      default: throw new UsageError(`unknown debug subcommand "${sub ?? ""}" (expected: ${SUBCOMMANDS.join(", ")})`);
    }
  },
};

