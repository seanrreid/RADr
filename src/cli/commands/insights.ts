// `radr insights` (PRD §16, §18): read-only views across every engagement in RADR_HOME.

import { canonicalJson } from "../../core/determinism.js";
import { UsageError } from "../../core/errors.js";
import { radrHome } from "../../engagement/home.js";
import { ruleInsights } from "../../insights/rules.js";
import { parse } from "../args.js";
import type { CommandSpec } from "../context.js";

const DEFAULT_MIN_DECIDED = 3;

export const insights: CommandSpec = {
  name: "insights",
  usage: "radr insights rules [--min-decided <n>] [--rule <tool/rule>] [--json]",
  summary: "per-rule false-positive rates across engagements (rule-pack tuning)",
  run(args, ctx) {
    const { values, positionals } = parse(args, { "min-decided": { type: "string" }, rule: { type: "string" }, json: { type: "boolean" } }, 1);
    if (positionals[0] !== "rules") throw new UsageError(`unknown insight "${positionals[0] ?? ""}" (expected: rules)`);
    const min = values["min-decided"] === undefined ? DEFAULT_MIN_DECIDED : Number(values["min-decided"]);
    if (!Number.isInteger(min) || min < 0) throw new UsageError("--min-decided takes a whole number");
    const r = ruleInsights(radrHome(ctx.env));
    for (const s of r.skipped) ctx.err(`skipped ${s}`);

    if (values.rule !== undefined) {
      const s = r.rules.find((x) => x.rule === values.rule);
      if (s === undefined) throw new UsageError(`no findings for rule ${values.rule} in ${String(r.engagements)} engagement(s)`);
      ctx.out(`${s.rule}: ${String(s.findings)} finding(s) in ${String(s.engagements)} engagement(s); false-positive rate ${s.fpRatePct === null ? "n/a" : `${String(s.fpRatePct)}%`} (${String(s.falsePositives)} dismissed, ${String(s.truePositives)} confirmed by a person, ${String(s.auto)} by the rubric, ${String(s.undecided)} undecided)`);
      for (const d of r.dismissals.get(s.rule) ?? []) ctx.out(`  ${d.engagement}  ${d.id}  ${d.location}  ${d.reason === "" ? "(no reason)" : d.reason}`);
      return;
    }
    const shown = r.rules.filter((s) => s.falsePositives + s.truePositives >= min);
    if (values.json === true) {
      for (const s of shown) ctx.out(canonicalJson({ ...s }));
      return;
    }
    ctx.out(`rules across ${String(r.engagements)} engagement(s), with at least ${String(min)} finding(s) decided by a person:`);
    if (shown.length === 0) {
      ctx.out("  none yet (decide more findings, or lower --min-decided)");
      return;
    }
    ctx.out(`  ${"FP rate".padEnd(8)} ${"dismissed".padEnd(10)} ${"confirmed".padEnd(10)} ${"auto".padEnd(5)} ${"open".padEnd(5)} rule`);
    for (const s of shown) {
      ctx.out(`  ${(s.fpRatePct === null ? "n/a" : `${String(s.fpRatePct)}%`).padEnd(8)} ${String(s.falsePositives).padEnd(10)} ${String(s.truePositives).padEnd(10)} ${String(s.auto).padEnd(5)} ${String(s.undecided).padEnd(5)} ${s.rule}`);
    }
    ctx.out("details and dismissal reasons: radr insights rules --rule <tool/rule>");
  },
};
