// Remediation plan (PRD §12): open findings grouped into work items, sized by the rubric's
// effort table, sequenced into waves by severity. Every item names the finding ids it closes,
// and its acceptance criterion is re-runnable: those ids absent from a later `radr review`
// (what `radr verify` checks in M6). Pure function of the inputs.

import { stableSort } from "../core/determinism.js";
import type { DispositionState } from "../findings/disposition.js";
import type { Finding, Severity } from "../findings/types.js";
import { sevRank } from "../rubric/rubric.js";

export type ItemKind = "dependency-upgrade" | "secret-rotation" | "lint-cleanup" | "type-errors" | "sast-fix" | "build-reproducibility" | "test-coverage" | "flaky-tests"
  | "reduce-complexity" | "deduplicate" | "iac-hardening" | "license-review" | "repo-hygiene";

export interface PlanItem {
  readonly key: string;
  readonly kind: ItemKind;
  readonly title: string;
  readonly severity: Severity;
  readonly effort: string;
  readonly findings: readonly string[];
  readonly acceptance: string;
}

export interface PlanWave {
  readonly wave: number;
  readonly label: string;
  readonly items: readonly PlanItem[];
}

/** States that still need remediation. Dismissed (false positive) and waived (accepted risk) don't. */
const OPEN: ReadonlySet<DispositionState> = new Set(["pending", "confirmed", "regressed"]);

function kindOf(f: Finding): ItemKind {
  if (f.lane === "sca") return "dependency-upgrade";
  if (f.lane === "secrets") return "secret-rotation";
  if (f.lane === "types") return "type-errors";
  if (f.tool === "radr-build") return "build-reproducibility";
  if (f.tool === "radr-coverage") return f.rule_id === "unstable-results" ? "flaky-tests" : "test-coverage";
  if (f.lane === "sast") return "sast-fix";
  if (f.tool === "lizard") return "reduce-complexity";
  if (f.tool === "jscpd") return "deduplicate";
  if (f.lane === "iac") return "iac-hardening";
  if (f.lane === "license") return "license-review";
  if (f.lane === "hygiene") return "repo-hygiene";
  return "lint-cleanup";
}

function groupKey(f: Finding, kind: ItemKind): string {
  switch (kind) {
    case "dependency-upgrade": return `${kind}:${f.tags.find((t) => t.startsWith("package:")) ?? f.file}`;
    case "secret-rotation": return `${kind}:${f.id}`; // every credential is rotated individually
    case "type-errors":
    case "lint-cleanup":
    case "reduce-complexity":
    case "deduplicate": return `${kind}:${f.tool}`;
    case "license-review": return `${kind}:${f.tags.find((t) => t.startsWith("license-class:")) ?? f.rule_id}`;
    default: return `${kind}:${f.tool}:${f.rule_id}`;
  }
}

function titleFor(kind: ItemKind, group: readonly Finding[]): string {
  const f = group[0];
  if (f === undefined) return kind;
  const n = group.length;
  switch (kind) {
    case "dependency-upgrade": {
      const pkg = f.tags.find((t) => t.startsWith("package:"))?.slice("package:".length) ?? f.file;
      const ids = stableSort([...new Set(group.flatMap((g) => (g.cve !== null ? [g.cve] : [g.rule_id])))], (x) => x);
      return `Upgrade ${pkg} (${ids.join(", ")})`;
    }
    case "secret-rotation":
      return f.tags.includes("history-only")
        ? `Rotate the credential exposed in git history (${f.file}); it is no longer in the current code, but anyone with the repository can recover it`
        : `Rotate the credential in ${f.file} and remove it from the codebase`;
    case "type-errors": return `Fix ${String(n)} type error${n === 1 ? "" : "s"} reported by ${f.tool}`;
    case "lint-cleanup": return `Resolve ${String(n)} ${f.tool} finding${n === 1 ? "" : "s"}`;
    case "build-reproducibility": return "Make the project install from a clean checkout with the declared steps";
    case "flaky-tests": return "Stabilize the test suite (results differ between identical runs)";
    case "test-coverage": return "Fix the failing test suite";
    case "sast-fix": return `Fix ${String(n)} occurrence${n === 1 ? "" : "s"} of ${f.rule_id}`;
    case "reduce-complexity": return `Reduce the complexity of ${String(n)} function${n === 1 ? "" : "s"} (cyclomatic complexity above the threshold)`;
    case "deduplicate": return `Consolidate ${String(n)} duplicated code block${n === 1 ? "" : "s"}`;
    case "iac-hardening": return `Fix ${f.tool} ${f.rule_id} in ${String(n)} place${n === 1 ? "" : "s"}`;
    case "license-review": {
      const cls = f.tags.find((t) => t.startsWith("license-class:"))?.slice("license-class:".length) ?? "unknown";
      const ids = stableSort([...new Set(group.map((g) => g.rule_id))], (x) => x);
      return `Review ${String(n)} ${cls} license use${n === 1 ? "" : "s"} (${ids.join(", ")}) against how the code is distributed`;
    }
    case "repo-hygiene": return `Improve ${f.rule_id} (${f.message})`;
  }
}

const WAVES: readonly { wave: number; label: string; min: Severity }[] = [
  { wave: 1, label: "Fix now (critical and high)", min: "high" },
  { wave: 2, label: "Schedule this cycle (medium)", min: "medium" },
  { wave: 3, label: "Opportunistic (low and info)", min: "info" },
];

export function buildPlan(findings: readonly Finding[], states: ReadonlyMap<string, DispositionState>, effortByKind: Readonly<Record<string, string>>): PlanWave[] {
  const open = findings.filter((f) => OPEN.has(states.get(f.id) ?? "pending"));
  const groups = new Map<string, { kind: ItemKind; members: Finding[] }>();
  for (const f of stableSort(open, (x) => x.id)) {
    const kind = kindOf(f);
    const key = groupKey(f, kind);
    const g = groups.get(key) ?? { kind, members: [] };
    g.members.push(f);
    groups.set(key, g);
  }
  const items: PlanItem[] = [...groups].map(([key, g]) => {
    const severity = g.members.reduce<Severity>((s, f) => (sevRank(f.severity) > sevRank(s) ? f.severity : s), "info");
    const ids = g.members.map((f) => f.id);
    return {
      key, kind: g.kind, title: titleFor(g.kind, g.members), severity, effort: effortByKind[g.kind] ?? "M", findings: ids,
      acceptance: g.kind === "secret-rotation"
        ? `Client confirms the credential was rotated; a re-review no longer reports ${ids.join(", ")}`
        : `A re-review at the fixed commit no longer reports ${ids.join(", ")}`,
    };
  });
  return WAVES.map((w, i) => {
    const upper = WAVES[i - 1]?.min;
    const inWave = items.filter((it) => sevRank(it.severity) >= sevRank(w.min) && (upper === undefined || sevRank(it.severity) < sevRank(upper)));
    return { wave: w.wave, label: w.label, items: stableSort(inWave, (it) => [-sevRank(it.severity), it.kind, it.key]) };
  });
}
