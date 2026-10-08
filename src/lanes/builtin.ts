// M1 lanes (T4.2–T4.5): census, lint (baseline mode), secrets, sca. Each runs pinned binaries
// against the read-only worktree with a scrubbed environment and stores raw output untouched.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ParseError, eslintAdapter, gitleaksAdapter, opengrepAdapter, osvAdapter, ruffAdapter, sccMetrics } from "../normalize/adapters.js";
import { ESLINT_BASELINE } from "../toolchain/install.js";
import { OSV_SUBDIR, STACK_ECOSYSTEM } from "../toolchain/db.js";
import { stableSort } from "../core/determinism.js";
import { execOutcome, rawDir, recordRun, toolEnv, type Lane, type ToolRun } from "./lane.js";
import { bin, combine, listFiles, realWorktree, snippetReader, step, type StepOutcome } from "./steps.js";
import { hygiene, iac, license, maint } from "./health.js";
import { history, tests } from "./metrics.js";
import { coverage, eslintProject, stackLint, stackLintSkipped, types } from "./sandboxed.js";
import { lockfiles, sastCoverage } from "../review/coverage.js";
import { readinessMetrics } from "../review/readiness.js";

export const census: Lane = {
  id: "census",
  tools: ["scc"],
  async run(ctx) {
    let metrics: Record<string, unknown> | undefined;
    const s = await step(ctx, "census", "scc", "scc.json",
      () => ctx.tools.exec({ command: bin(ctx, "scc"), args: ["--format", "json", "--no-cocomo", "--by-file", "--no-gitignore", "--no-ignore", "."], cwd: ctx.layout.worktree, env: toolEnv(ctx) }),
      (raw) => { metrics = sccMetrics(raw); return []; });
    // Readiness for AI-assisted development: suppressions, TS strictness, CI checks, agent files.
    if (metrics !== undefined) {
      const files = (metrics["files"] ?? {}) as Parameters<typeof readinessMetrics>[2];
      metrics = { ...metrics, readiness: readinessMetrics(realWorktree(ctx), listFiles(realWorktree(ctx)), files) };
    }
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
          // --no-inline-config: an eslint-disable comment in client code can't hide a baseline
          // finding (the baseline is radr's config, not the client's; inline comments are config too).
          args: [path.join(nt, "node_modules", "eslint", "bin", "eslint.js"), "--config", path.join(nt, ESLINT_BASELINE), "--format", "json",
            "--no-warn-ignored", "--no-error-on-unmatched-pattern", "--no-inline-config", "."],
          cwd: wt, env: toolEnv(ctx), okExitCodes: [0, 1],
        }),
        (raw, ref) => eslintAdapter({ raw, rawRef: ref, repoRoot: wt, toolVersion: ctx.tools.versions["node-tools"] ?? "", snippet: read })));
    }
    if (ctx.doc.stacks.includes("python")) {
      steps.push(await step(ctx, "lint", "ruff", "ruff.json",
        () => ctx.tools.exec({
          command: bin(ctx, "ruff"),
          args: ["check", "--config", ctx.tools.ruffConfig, "--output-format", "json", "--no-cache", "--exit-zero", "--ignore-noqa", "."],
          cwd: wt, env: toolEnv(ctx),
        }),
        (raw, ref) => ruffAdapter({ raw, rawRef: ref, repoRoot: wt, toolVersion: ctx.tools.versions["ruff"] ?? "", snippet: read })));
    }
    // M3 W5: golangci-lint, clippy, PMD, RuboCop, .NET analyzers run in the stack sandboxes
    // (they need the stack's toolchain). Triage stays static-only.
    const stack = ctx.doc.tier === "triage" ? stackLintSkipped(ctx, "the triage tier runs static linters only") : await stackLint(ctx);
    steps.push(...stack.parts);
    // Coverage: which stacks were linted, and why the others weren't.
    const host = [
      ...(ctx.doc.stacks.includes("typescript-javascript") && steps.some((x) => x.run?.tool === "eslint" && x.outcome === "success") ? ["typescript-javascript"] : []),
      ...(ctx.doc.stacks.includes("python") && steps.some((x) => x.run?.tool === "ruff" && x.outcome === "success") ? ["python"] : []),
    ];
    return combine(steps, { linted: [...host, ...stack.linted].sort(), skipped: stack.skipped });
  },
};

/**
 * gitleaks:allow comments and a .gitleaksignore in the client repo can't hide a secret: radr
 * ignores the comments and points the ignore path at an empty directory it owns.
 */
function gitleaksNoSuppress(rawDirPath: string): string[] {
  const empty = path.join(rawDirPath, "no-gitleaksignore");
  mkdirSync(empty, { recursive: true });
  return ["--ignore-gitleaks-allow", `--gitleaks-ignore-path=${empty}`];
}

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
      // Triage scans HEAD only (PRD §5); the diff tier, the PR's own commits (base..head, M6);
      // every other tier, the approved SHA's full history.
      args: ctx.doc.tier === "triage"
        ? ["dir", ...gitleaksNoSuppress(dir), "--redact", "--no-banner", "--log-level=warn", "--report-format", "json", "--report-path", report, "--exit-code", "0", wt]
        : ["git", `--log-opts=${ctx.doc.diff === undefined ? sha : `${ctx.doc.diff.base}..${sha}`}`, ...gitleaksNoSuppress(dir), "--redact", "--no-banner", "--log-level=warn", "--report-format", "json", "--report-path", report, "--exit-code", "0", ctx.layout.mirror],
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
    const osvDb = ctx.tools.osvDb;
    if (osvDb === null) return { outcome: "tool-missing", tools: [], findings: [], detail: "no OSV snapshot pinned (snapshots.lock)" };
    // osv-scanner offline exits 127 with a generic error when an ecosystem's DB is absent; say which.
    const needed = stableSort([...new Set(ctx.doc.stacks.flatMap((s) => STACK_ECOSYSTEM[s] ?? []))], (e) => e);
    const absent = needed.filter((e) => !existsSync(path.join(osvDb, OSV_SUBDIR, e, "all.zip")));
    if (absent.length > 0) return { outcome: "tool-missing", tools: [], findings: [], detail: `the pinned OSV snapshot has no ${absent.join(", ")} database (run \`radr db sync\`, then \`radr scope\`)` };
    const osv = await step(ctx, "sca", "osv-scanner", "osv-scanner.json",
      () => ctx.tools.exec({
        command: bin(ctx, "osv-scanner"),
        // No call analysis (it runs only when a Go/Rust toolchain happens to be on PATH, so host and
        // image would differ) and no transitive resolution (it needs registries): lockfiles only.
        args: ["scan", "source", "--offline", "--no-call-analysis=all", "--no-resolve", "--format", "json", "-r", "."],
        cwd: wt, env: toolEnv(ctx, { OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: osvDb }),
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
    // Coverage: which lockfiles there were to read. None means "not assessed", not "no vulns".
    return combine([osv, syft], { lockfiles: lockfiles(listFiles(wt)) });
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
    const metrics: Record<string, unknown> = {};
    const s = await step(ctx, "sast", "opengrep", "opengrep.json",
      () => ctx.tools.exec({
        command: bin(ctx, "opengrep"),
        // --disable-nosem: a `nosemgrep` comment in client code can't hide a SAST finding.
        args: ["scan", "--no-rewrite-rule-ids", "--disable-nosem", ...configs, "--json", "--quiet", "."],
        cwd: wt, env: toolEnv(ctx, OPENGREP_ENV), okExitCodes: [0, 1], timeoutMs: 30 * 60 * 1000,
      }),
      (raw, ref) => {
        Object.assign(metrics, sastCoverage(raw, ctx.metrics["census"]));
        return opengrepAdapter({ raw, rawRef: ref, repoRoot: wt, toolVersion: ctx.tools.versions["opengrep"] ?? "", snippet: snippetReader(wt) });
      });
    return combine([s], metrics);
  },
};

export { worstOutcome } from "./steps.js";
export const LANES: Readonly<Record<string, Lane>> = { census, lint, secrets, sca, history, tests, types, coverage, sast, maint, license, iac, hygiene };
