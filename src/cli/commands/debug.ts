// `radr debug` (PRD §11, M5): the root-cause workflow. Subcommands record events; the gates
// in src/debug/state.ts decide what may happen next.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { resolveActor } from "../../core/actor.js";
import { RefusedError, UsageError } from "../../core/errors.js";
import { bisect } from "../../debug/bisect.js";
import { debugSandbox, runDebugScript, scriptHash } from "../../debug/sandbox.js";
import { gitOut } from "../../engagement/git.js";
import { assertOpen, getDebug, debugStates, nextId, reproducing, type DebugState } from "../../debug/state.js";
import { radrHome, resolveEngagement, type Layout } from "../../engagement/home.js";
import { readJudgments } from "../../findings/judgments.js";
import { readStore } from "../../findings/store.js";
import { assertScope, snapshotsFor } from "../../review/run.js";
import { EventLog } from "../../state/events.js";
import { Gates } from "../../state/gates.js";
import { ENGAGEMENT_OPTION, parse } from "../args.js";
import type { CliContext, CommandSpec } from "../context.js";

const SUBCOMMANDS = ["open", "list", "show", "repro", "bisect"] as const;

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
      default: throw new UsageError(`unknown debug subcommand "${sub ?? ""}" (expected: ${SUBCOMMANDS.join(", ")})`);
    }
  },
};

