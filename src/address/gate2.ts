// Gate 2: report sign-off (PRD §7, M2 AC11). `radr approve report` freezes the hashes of the
// findings set, report.md, remediation.md, and the theme; `radr render` (and anything else
// client-facing) re-checks them via policy/gates.yml (report-hashes-equal).

import { existsSync, readFileSync } from "node:fs";
import type { Clock } from "../core/clock.js";
import { assetPath } from "../core/assets.js";
import { hashBytes, stableSort } from "../core/determinism.js";
import { RefusedError } from "../core/errors.js";
import type { Layout } from "../engagement/home.js";
import { findingsSetHash } from "../findings/store.js";
import path from "node:path";
import { stateOf } from "../findings/disposition.js";
import { DRAFT_MARKER, filesWithDrafts } from "../llm/draft.js";
import { inReviewSet } from "../rubric/rubric.js";
import { treeHash } from "../sandbox/deps.js";
import { EventLog } from "../state/events.js";
import { Gates } from "../state/gates.js";
import { dispositionsHash, loadRunInputs, type RunInputs } from "./inputs.js";
import { addressPaths } from "./report.js";

export const DEFAULT_THEME = "torchcodelab";
const SHOW_IDS = 10;

export function themeName(inp: RunInputs): string {
  return inp.doc.theme ?? DEFAULT_THEME;
}

export function themeDir(name: string): string {
  const dir = assetPath(`themes/${name}`);
  if (!existsSync(dir)) throw new RefusedError(`theme "${name}" not found under themes/`);
  return dir;
}

/** The hashes Gate 2 freezes, computed from the current state (field names match the event). */
export function currentReportHashes(l: Layout, inp: RunInputs): Record<string, string> {
  const p = addressPaths(l);
  for (const f of [p.report, p.remediation]) if (!existsSync(f)) throw new RefusedError(`${f} not found (run \`radr address\`)`);
  return {
    run_id: inp.runId,
    findings_set_hash: findingsSetHash(inp.findings),
    dispositions_hash: dispositionsHash(inp),
    report_hash: hashBytes(readFileSync(p.report)),
    remediation_hash: hashBytes(readFileSync(p.remediation)),
    theme: themeName(inp),
    theme_hash: treeHash(themeDir(themeName(inp))).hash,
  };
}

/** Front-matter `key: "value"` (JSON-quoted, as radr writes it) from a generated document. */
function frontMatterValue(text: string, key: string): string | undefined {
  const m = new RegExp(`^${key}: ("(?:[^"\\\\]|\\\\.)*")$`, "m").exec(text.split("\n---")[0] ?? "");
  return m?.[1] === undefined ? undefined : (JSON.parse(m[1]) as string);
}

/** Who last set each finding's disposition (to tell a human decision from a rubric one). */
function lastActors(inp: RunInputs): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of inp.events) if (e.type === "finding-disposition") out.set(String(e.data["finding_id"]), e.actor);
  return out;
}

export function approveReport(l: Layout, actor: string, clock: Clock, acceptPartial?: string): { runId: string; hashes: Record<string, string> } {
  const inp = loadRunInputs(l, clock);
  if (inp.runStatus === "aborted") throw new RefusedError(`run ${inp.runId} was aborted; there is nothing to sign off`);
  const hashes = currentReportHashes(l, inp);
  const report = readFileSync(addressPaths(l).report, "utf8");
  if (frontMatterValue(report, "run") !== inp.runId || frontMatterValue(report, "findings_set") !== hashes["findings_set_hash"] || frontMatterValue(report, "dispositions") !== hashes["dispositions_hash"]) {
    throw new RefusedError("report.md is out of date: it was generated for a different run, findings set, or set of dispositions (run `radr address`)");
  }

  const live = inp.findings.filter((f) => inp.states.get(f.id) !== "dismissed");
  const pending = stableSort(live.filter((f) => (inp.states.get(f.id) ?? "pending") === "pending"), (f) => f.id).map((f) => f.id);
  if (pending.length > 0) {
    throw new RefusedError(`${String(pending.length)} finding(s) still pending: ${pending.slice(0, SHOW_IDS).join(", ")}${pending.length > SHOW_IDS ? ", …" : ""} (use \`radr disposition\`)`);
  }
  // The review set must carry a HUMAN decision, even if the rubric auto-confirmed a finding
  // before re-assessment raised it into the review set.
  const routing = inp.rubric.routing;
  if (routing !== undefined) {
    const actors = lastActors(inp);
    const machineOnly = stableSort(live.filter((f) => inReviewSet(routing, f) && (actors.get(f.id) ?? "").startsWith("rubric@")), (f) => f.id).map((f) => f.id);
    if (machineOnly.length > 0) {
      throw new RefusedError(`review-set finding(s) confirmed only by the rubric, not by a person: ${machineOnly.slice(0, SHOW_IDS).join(", ")} (confirm, dismiss, or waive them yourself)`);
    }
  }
  // An LLM draft (M4) must be read by a person, who deletes its marker, before sign-off.
  const drafts = filesWithDrafts(l);
  if (drafts.length > 0) {
    throw new RefusedError(`unreviewed LLM draft in ${drafts.map((f) => path.basename(f)).join(", ")}: review the text and delete the ${DRAFT_MARKER} line, then run \`radr address\``);
  }
  // Judgment findings (M4) are LLM proposals: each needs a person's decision, and a proposed or
  // pending one blocks sign-off like a pending tool finding does (PRD Gate 2).
  const undecided = inp.judgments.filter((j) => ["proposed", "pending"].includes(stateOf(inp.states, j.id))).map((j) => `${j.id} (${stateOf(inp.states, j.id)})`);
  if (undecided.length > 0) {
    throw new RefusedError(`judgment finding(s) not yet decided: ${undecided.slice(0, SHOW_IDS).join(", ")}${undecided.length > SHOW_IDS ? ", …" : ""} (confirm or dismiss them with \`radr disposition\`)`);
  }
  if (inp.runStatus === "partial" && (acceptPartial === undefined || acceptPartial.trim() === "")) {
    const partialLanes = stableSort([...inp.lanes].filter(([, o]) => o !== "success").map(([k]) => k), (k) => k);
    throw new RefusedError(`run ${inp.runId} is partial (${partialLanes.join(", ")}); re-run, or sign off with --accept-partial "<reason>" (printed on the report cover)`);
  }

  new EventLog(l.events, clock).append("report-approved", actor, {
    ...hashes,
    ...(inp.runStatus === "partial" && acceptPartial !== undefined ? { accepted_partial: acceptPartial } : {}),
  });
  return { runId: inp.runId, hashes };
}

/** Gate 2 check for anything client-facing (render). Throws unless the approval still matches. */
export function assertReportApproved(l: Layout, clock: Clock): { inp: RunInputs; hashes: Record<string, string>; acceptedPartial: string | undefined } {
  const inp = loadRunInputs(l, clock);
  const hashes = currentReportHashes(l, inp);
  const g = Gates.load().evaluate("report", inp.events, { hashes });
  if (!g.passed) throw new RefusedError(g.reason);
  const accepted = g.event?.data["accepted_partial"];
  return { inp, hashes, acceptedPartial: typeof accepted === "string" ? accepted : undefined };
}
