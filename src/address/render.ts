// `radr render` (PRD §12, M2 AC12): report.md / remediation.md → PDF with pinned pandoc
// (Markdown → Typst) and Typst (→ PDF). Refuses without a matching Gate 2 approval.
// Deterministic: no system fonts, a creation timestamp taken from the run date, and every
// input (theme files, metadata, body) staged into one directory. Same inputs → same bytes.

import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Clock } from "../core/clock.js";
import { canonicalJson, hashBytes } from "../core/determinism.js";
import { RefusedError } from "../core/errors.js";
import { run } from "../core/exec.js";
import type { Layout } from "../engagement/home.js";
import { doctor } from "../toolchain/doctor.js";
import { assertReportApproved, themeDir, themeName } from "./gate2.js";
import { addressPaths } from "./report.js";

const RENDER_TIMEOUT_MS = 5 * 60 * 1000;
const TYPE_LABEL: Readonly<Record<string, string>> = {
  triage: "Triage review", quality: "Code quality review", "health-audit": "Codebase health audit", security: "Security review",
  "due-diligence": "Technical due diligence", "pr-review": "Pull request review", debug: "Root-cause analysis",
};

/** Front-matter `key: "value"` from a radr-generated document. */
function front(text: string, key: string): string | undefined {
  const m = new RegExp(`^${key}: ("(?:[^"\\\\]|\\\\.)*")$`, "m").exec(text.split("\n---")[0] ?? "");
  return m?.[1] === undefined ? undefined : (JSON.parse(m[1]) as string);
}

/** Unix seconds for a YYYY-MM-DD date at 00:00 UTC (no wall clock). */
export function epochOf(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (m === null) throw new RefusedError(`invalid document date "${date}"`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000;
}

export interface RenderResult {
  readonly pdfs: readonly { readonly path: string; readonly hash: string }[];
}

export async function render(home: string, l: Layout, clock: Clock): Promise<RenderResult> {
  const { inp, acceptedPartial } = assertReportApproved(l, clock);
  const checks = await doctor(home);
  const tool = (name: string): string => {
    const c = checks.find((x) => x.tool === name);
    if (c?.state !== "ok" || c.binPath === undefined) throw new RefusedError(`${name} is not ready (${c?.detail ?? "missing"}); run \`radr tools install\``);
    return c.binPath;
  };
  const pandoc = tool("pandoc");
  const typst = tool("typst");
  const theme = themeDir(themeName(inp));
  const paths = addressPaths(l);
  const pdfs: { path: string; hash: string }[] = [];

  for (const [kind, src, out, heading] of [
    ["report", paths.report, path.join(l.dir, "report", "report.pdf"), "Code review report"],
    ["remediation", paths.remediation, path.join(l.dir, "plan", "remediation.pdf"), "Remediation plan"],
  ] as const) {
    const md = readFileSync(src, "utf8");
    const date = front(md, "date") ?? "";
    const stage = path.join(l.dir, "report", `.render-${kind}`);
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });
    cpSync(theme, stage, { recursive: true });

    const meta = {
      kind, heading, title: front(md, "title") ?? heading, client: inp.doc.client, engagement: l.id,
      engagement_label: TYPE_LABEL[inp.doc.engagement_type] ?? inp.doc.engagement_type,
      date, run: inp.runId, commit: inp.doc.source.sha, verdict: kind === "report" ? (front(md, "verdict") ?? "n/a") : "n/a",
      accepted_partial: acceptedPartial ?? null,
    };
    writeFileSync(path.join(stage, "meta.json"), canonicalJson(meta));

    const p = await run({
      command: pandoc, args: ["--from", "markdown-smart+pipe_tables", "--to", "typst", "--columns", "100", "--output", path.join(stage, "body.typ"), src],
      cwd: stage, env: { HOME: stage }, timeoutMs: RENDER_TIMEOUT_MS,
    });
    if (p.outcome !== "ok") throw new RefusedError(`pandoc failed on ${path.basename(src)}: ${p.stderr.toString().trim().split("\n").at(-1) ?? p.outcome}`);

    const pdfTmp = path.join(stage, "out.pdf");
    const t = await run({
      command: typst,
      args: ["compile", "--root", stage, "--font-path", path.join(stage, "fonts"), "--ignore-system-fonts", "--creation-timestamp", String(epochOf(date)), "main.typ", pdfTmp],
      cwd: stage, env: { HOME: stage, SOURCE_DATE_EPOCH: String(epochOf(date)) }, timeoutMs: RENDER_TIMEOUT_MS,
    });
    if (t.outcome !== "ok") throw new RefusedError(`typst failed on ${kind}: ${t.stderr.toString().trim().split("\n").slice(0, 3).join(" | ") || t.outcome}`);
    mkdirSync(path.dirname(out), { recursive: true });
    copyFileSync(pdfTmp, out);
    rmSync(stage, { recursive: true, force: true });
    pdfs.push({ path: out, hash: hashBytes(readFileSync(out)) });
  }
  return { pdfs };
}
