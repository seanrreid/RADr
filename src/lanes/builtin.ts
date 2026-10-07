// M1 lanes (T4.2–T4.5): census, lint (baseline mode), secrets, sca. Each runs pinned binaries
// against the read-only worktree with a scrubbed environment and stores raw output untouched.

import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { ExecResult } from "../core/exec.js";
import type { FindingDraft } from "../findings/types.js";
import { ParseError, eslintAdapter, gitleaksAdapter, opengrepAdapter, osvAdapter, ruffAdapter, sccMetrics, type SnippetReader } from "../normalize/adapters.js";
import { ESLINT_BASELINE } from "../toolchain/install.js";
import { execOutcome, rawDir, recordRun, toolEnv, type Lane, type LaneContext, type LaneOutcome, type LaneResult, type ToolRun } from "./lane.js";
import { history, tests } from "./metrics.js";
import { coverage, eslintProject, types } from "./sandboxed.js";

/** Most severe first: a lane with several tools reports the worst of their outcomes. */
const OUTCOME_RANK: readonly LaneOutcome[] = ["tool-missing", "version-drift", "tool-error", "timeout", "output-cap", "parse-error", "success"];
export function worstOutcome(outcomes: readonly LaneOutcome[]): LaneOutcome {
  return OUTCOME_RANK.find((o) => outcomes.includes(o)) ?? "success";
}

/**
 * The worktree's REAL path. Tools report resolved paths (on macOS /var → /private/var), so
 * normalizing against an unresolved root would make every in-repo path look like an escape.
 */
function realWorktree(ctx: LaneContext): string {
  return realpathSync(ctx.layout.worktree);
}

function snippetReader(root: string): SnippetReader {
  return (file, start, end) => {
    const abs = path.join(root, file);
    if (!existsSync(abs)) return null;
    const lines = readFileSync(abs, "utf8").split(/\r?\n/);
    const slice = lines.slice(start - 1, end);
    return slice.length === 0 ? null : slice.join("\n");
  };
}

function bin(ctx: LaneContext, tool: string): string {
  return ctx.tools.bins[tool] ?? `/nonexistent/${tool}`; // missing → exec reports tool-missing
}

/** Run one tool, store its output, and adapt it — mapping every failure to a typed outcome. */
async function step(
  ctx: LaneContext,
  lane: string,
  tool: string,
  file: string,
  exec: () => Promise<ExecResult>,
  adapt: (raw: string, rawRef: string) => FindingDraft[],
): Promise<{ outcome: LaneOutcome; run: ToolRun; findings: FindingDraft[]; detail?: string }> {
  const r = await exec();
  const toolRun = recordRun(ctx, lane, tool, file, r);
  const outcome = execOutcome(r.outcome);
  if (outcome !== "success") return { outcome, run: toolRun, findings: [], detail: `${tool}: ${r.error ?? (r.stderr.toString().trim().split("\n").at(-1) || r.outcome)}` };
  try {
    return { outcome, run: toolRun, findings: adapt(r.stdout.toString("utf8"), toolRun.raw_ref ?? "") };
  } catch (e) {
    if (e instanceof ParseError) return { outcome: "parse-error", run: toolRun, findings: [], detail: e.message };
    throw e;
  }
}

interface StepOutcome {
  readonly outcome: LaneOutcome;
  readonly run?: ToolRun;
  readonly findings: readonly FindingDraft[];
  readonly detail?: string;
}

function combine(steps: readonly StepOutcome[], metrics?: Record<string, unknown>): LaneResult {
  const detail = steps.map((s) => s.detail).filter((d) => d !== undefined).join("; ");
  return {
    outcome: worstOutcome(steps.map((s) => s.outcome)),
    tools: steps.flatMap((s) => (s.run === undefined ? [] : [s.run])),
    findings: steps.flatMap((s) => s.findings),
    ...(metrics !== undefined ? { metrics } : {}),
    ...(detail !== "" ? { detail } : {}),
  };
}

export const census: Lane = {
  id: "census",
  tools: ["scc"],
  async run(ctx) {
    let metrics: Record<string, unknown> | undefined;
    const s = await step(ctx, "census", "scc", "scc.json",
      () => ctx.tools.exec({ command: bin(ctx, "scc"), args: ["--format", "json", "--no-cocomo", "--by-file", "--no-gitignore", "--no-ignore", "."], cwd: ctx.layout.worktree, env: toolEnv(ctx) }),
      (raw) => { metrics = sccMetrics(raw); return []; });
    return combine([s], metrics);
  },
};

export const lint: Lane = {
  id: "lint",
  tools: ["ruff", "node-tools"],
  async run(ctx) {
    const steps: StepOutcome[] = [];
    const wt = realWorktree(ctx);
    const read = snippetReader(wt);
    const modes = ctx.doc.lint_modes ?? ["baseline"];
    if (modes.includes("project")) {
      // Project mode: the CLIENT's own config. ruff needs no deps, so it runs on the host
      // (no --config, so ruff discovers the client's pyproject/ruff.toml); eslint needs the
      // client's installed plugins, so it runs in the sandbox.
      if (ctx.doc.stacks.includes("python")) {
        steps.push(await step(ctx, "lint", "ruff-project", "ruff-project.json",
          () => ctx.tools.exec({ command: bin(ctx, "ruff"), args: ["check", "--output-format", "json", "--no-cache", "--exit-zero", "."], cwd: wt, env: toolEnv(ctx) }),
          (raw, ref) => ruffAdapter({ raw, rawRef: ref, repoRoot: wt, toolVersion: ctx.tools.versions["ruff"] ?? "", snippet: read }, "project")));
      }
      if (ctx.doc.stacks.includes("typescript-javascript")) steps.push(await eslintProject(ctx));
    }
    if (!modes.includes("baseline")) return combine(steps);
    if (ctx.doc.stacks.includes("typescript-javascript")) {
      const nt = ctx.tools.nodeTools;
      steps.push(await step(ctx, "lint", "eslint", "eslint.json",
        () => ctx.tools.exec({
          command: ctx.tools.node,
          args: [path.join(nt, "node_modules", "eslint", "bin", "eslint.js"), "--config", path.join(nt, ESLINT_BASELINE), "--format", "json",
            "--no-warn-ignored", "--no-error-on-unmatched-pattern", "."],
          cwd: wt, env: toolEnv(ctx), okExitCodes: [0, 1],
        }),
        (raw, ref) => eslintAdapter({ raw, rawRef: ref, repoRoot: wt, toolVersion: ctx.tools.versions["node-tools"] ?? "", snippet: read })));
    }
    if (ctx.doc.stacks.includes("python")) {
      steps.push(await step(ctx, "lint", "ruff", "ruff.json",
        () => ctx.tools.exec({
          command: bin(ctx, "ruff"),
          args: ["check", "--config", ctx.tools.ruffConfig, "--output-format", "json", "--no-cache", "--exit-zero", "."],
          cwd: wt, env: toolEnv(ctx),
        }),
        (raw, ref) => ruffAdapter({ raw, rawRef: ref, repoRoot: wt, toolVersion: ctx.tools.versions["ruff"] ?? "", snippet: read })));
    }
    return combine(steps);
  },
};

export const secrets: Lane = {
  id: "secrets",
  tools: ["gitleaks"],
  async run(ctx) {
    const sha = ctx.doc.source.sha;
    const dir = rawDir(ctx, "secrets");
    const report = path.join(dir, "gitleaks.json");
    const wt = realWorktree(ctx);
    const r = await ctx.tools.exec({
      command: bin(ctx, "gitleaks"),
      // Triage scans HEAD only (PRD §5); every other tier scans the approved SHA's full history.
      args: ctx.doc.tier === "triage"
        ? ["dir", "--redact", "--no-banner", "--log-level=warn", "--report-format", "json", "--report-path", report, "--exit-code", "0", wt]
        : ["git", `--log-opts=${sha}`, "--redact", "--no-banner", "--log-level=warn", "--report-format", "json", "--report-path", report, "--exit-code", "0", ctx.layout.mirror],
      cwd: ctx.layout.dir, env: toolEnv(ctx),
    });
    // gitleaks writes its report to a file; stdout holds only logs. Hash and adapt the report.
    const toolRun: ToolRun = { ...recordRun(ctx, "secrets", "gitleaks", "gitleaks.log", r), raw_ref: path.relative(ctx.layout.dir, report).split(path.sep).join("/") };
    const outcome = execOutcome(r.outcome);
    if (outcome !== "success") return { outcome, tools: [toolRun], findings: [], detail: `gitleaks: ${r.error ?? r.stderr.toString().trim().split("\n").at(-1) ?? ""}` };
    if (!existsSync(report)) return { outcome: "parse-error", tools: [toolRun], findings: [], detail: "gitleaks wrote no report" };
    try {
      const findings = gitleaksAdapter({
        raw: readFileSync(report, "utf8"), rawRef: toolRun.raw_ref ?? "", repoRoot: wt, toolVersion: ctx.tools.versions["gitleaks"] ?? "",
        snippet: () => null, presentAtHead: (f) => existsSync(path.join(wt, f)),
      });
      return { outcome: "success", tools: [toolRun], findings };
    } catch (e) {
      if (e instanceof ParseError) return { outcome: "parse-error", tools: [toolRun], findings: [], detail: e.message };
      throw e;
    }
  },
};

export const sca: Lane = {
  id: "sca",
  tools: ["osv-scanner", "syft"],
  async run(ctx) {
    const wt = realWorktree(ctx);
    if (ctx.tools.osvDb === null) return { outcome: "tool-missing", tools: [], findings: [], detail: "no OSV snapshot pinned (snapshots.lock)" };
    const osv = await step(ctx, "sca", "osv-scanner", "osv-scanner.json",
      () => ctx.tools.exec({
        command: bin(ctx, "osv-scanner"),
        args: ["scan", "source", "--offline", "--format", "json", "-r", "."],
        cwd: wt, env: toolEnv(ctx, { OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: ctx.tools.osvDb ?? "" }),
        okExitCodes: [0, 1, 128], // 1 = vulnerabilities found, 128 = no packages found
      }),
      (raw, ref) => (raw.trim() === "" ? [] : osvAdapter({ raw, rawRef: ref, repoRoot: wt, toolVersion: ctx.tools.versions["osv-scanner"] ?? "", snippet: () => null })));
    // The SBOM is an artifact, not findings: SPDX output embeds a timestamp and a random
    // document namespace, so it is stored and hashed but never part of the findings set.
    mkdirSync(ctx.layout.artifacts, { recursive: true });
    const sbomPath = path.join(ctx.layout.artifacts, `sbom-${ctx.runId}.spdx.json`);
    const syft = await step(ctx, "sca", "syft", "syft.log",
      () => ctx.tools.exec({ command: bin(ctx, "syft"), args: ["scan", "dir:.", "-o", `spdx-json=${sbomPath}`, "-q"], cwd: wt, env: toolEnv(ctx, { SYFT_CHECK_FOR_APP_UPDATE: "false" }) }),
      () => []);
    return combine([osv, syft]);
  },
};


/** UTF-8 locale for Opengrep: it is a bundled Python app that crashes decoding rules under LC_ALL=C. */
const OPENGREP_ENV = { LC_ALL: "C.UTF-8", LANG: "C.UTF-8" } as const;

export const sast: Lane = {
  id: "sast",
  tools: ["opengrep"],
  async run(ctx) {
    const wt = realWorktree(ctx);
    const packs = ctx.doc.rule_packs ?? ["authored", "pack", "lgpl"];
    const configs = packs.flatMap((p) => ["--config", path.join(ctx.tools.rulesDir, p)]);
    const s = await step(ctx, "sast", "opengrep", "opengrep.json",
      () => ctx.tools.exec({
        command: bin(ctx, "opengrep"),
        args: ["scan", "--no-rewrite-rule-ids", ...configs, "--json", "--quiet", "."],
        cwd: wt, env: toolEnv(ctx, OPENGREP_ENV), okExitCodes: [0, 1], timeoutMs: 30 * 60 * 1000,
      }),
      (raw, ref) => opengrepAdapter({ raw, rawRef: ref, repoRoot: wt, toolVersion: ctx.tools.versions["opengrep"] ?? "", snippet: snippetReader(wt) }));
    return combine([s]);
  },
};

export const LANES: Readonly<Record<string, Lane>> = { census, lint, secrets, sca, history, tests, types, coverage, sast };
