// `radr insights rules` (PRD §16, §18): per-rule false-positive rates across every engagement
// in RADR_HOME, from the consultant's dispositions. Input for tuning the rule pack.
//
// Per finding (every finding an engagement ever recorded), its current state decides:
//   dismissed by a person                         → false positive
//   confirmed / waived / fixed / verified / regressed, last moved by a person or verify
//                                                 → true positive (decided)
//   confirmed only by the rubric (rubric@…)       → auto: not a human judgment, not in the rate
//   pending / proposed                            → undecided
// FP rate = false positives ÷ (false positives + decided true positives), in integer percent.
// Read-only and deterministic: engagements in code-point order, integer arithmetic only.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { compareCodePoints, stableSort } from "../core/determinism.js";
import { RadrError } from "../core/errors.js";
import { dispositions, initialState } from "../findings/disposition.js";
import { readJudgments } from "../findings/judgments.js";
import { readStore } from "../findings/store.js";
import type { Finding } from "../findings/types.js";
import { layout } from "../engagement/home.js";
import { parseLog, type Event } from "../state/events.js";

export interface RuleStats {
  readonly rule: string;
  readonly findings: number;
  readonly falsePositives: number;
  readonly truePositives: number;
  readonly auto: number;
  readonly undecided: number;
  /** Integer percent; null when nothing was decided by a person. */
  readonly fpRatePct: number | null;
  readonly engagements: number;
}

export interface Dismissal {
  readonly engagement: string;
  readonly id: string;
  readonly location: string;
  readonly reason: string;
}

export interface Insights {
  readonly rules: readonly RuleStats[];
  readonly dismissals: ReadonlyMap<string, readonly Dismissal[]>;
  /** Engagements that couldn't be read (a broken event chain, a corrupt store), with why. */
  readonly skipped: readonly string[];
  readonly engagements: number;
}

const TRUE_STATES = new Set(["confirmed", "waived", "fixed", "verified", "regressed"]);

function lastMove(events: readonly Event[]): Map<string, { actor: string; reason: string }> {
  const out = new Map<string, { actor: string; reason: string }>();
  for (const e of events) {
    if (e.type === "finding-disposition") out.set(String(e.data["finding_id"]), { actor: e.actor, reason: typeof e.data["reason"] === "string" ? e.data["reason"] : "" });
  }
  return out;
}

export function ruleInsights(home: string): Insights {
  const root = path.join(home, "engagements");
  const ids = existsSync(root) ? readdirSync(root).sort(compareCodePoints) : [];
  const acc = new Map<string, { findings: number; fp: number; tp: number; auto: number; undecided: number; engagements: Set<string> }>();
  const dismissals = new Map<string, Dismissal[]>();
  const skipped: string[] = [];
  let counted = 0;
  for (const id of ids) {
    let l;
    let events: Event[];
    let findings: Finding[];
    try {
      l = layout(home, id);
      if (!existsSync(l.events)) continue;
      events = parseLog(readFileSync(l.events, "utf8"), l.events);
      findings = [...readStore(l.findings).findings, ...readJudgments(l.judgments)];
    } catch (e) {
      if (!(e instanceof RadrError)) throw e;
      skipped.push(`${id}: ${e.message}`);
      continue;
    }
    counted++;
    const states = dispositions(events);
    const moves = lastMove(events);
    for (const f of findings) {
      const rule = `${f.tool}/${f.rule_id}`;
      const a = acc.get(rule) ?? { findings: 0, fp: 0, tp: 0, auto: 0, undecided: 0, engagements: new Set<string>() };
      a.findings++;
      a.engagements.add(id);
      const state = states.get(f.id) ?? initialState(f.id);
      const move = moves.get(f.id);
      if (state === "dismissed") {
        a.fp++;
        const list = dismissals.get(rule) ?? [];
        list.push({ engagement: id, id: f.id, location: f.line > 0 ? `${f.file}:${String(f.line)}` : f.file, reason: move?.reason ?? "" });
        dismissals.set(rule, list);
      } else if (TRUE_STATES.has(state)) {
        if (move?.actor.startsWith("rubric@") === true) a.auto++;
        else a.tp++;
      } else {
        a.undecided++;
      }
      acc.set(rule, a);
    }
  }
  const rules = [...acc].map(([rule, a]): RuleStats => ({
    rule, findings: a.findings, falsePositives: a.fp, truePositives: a.tp, auto: a.auto, undecided: a.undecided,
    fpRatePct: a.fp + a.tp === 0 ? null : Math.floor((a.fp * 100) / (a.fp + a.tp)), engagements: a.engagements.size,
  }));
  return {
    rules: stableSort(rules, (r) => [-(r.fpRatePct ?? -1), -(r.falsePositives + r.truePositives), r.rule]),
    dismissals, skipped, engagements: counted,
  };
}
