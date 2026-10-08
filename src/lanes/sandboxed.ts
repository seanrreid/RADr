// Sandboxed lanes (M2 W3): types, coverage, and the eslint half of lint project mode. Each runs
// CLIENT CODE in the build sandbox (src/sandbox/runtime.ts): offline by default, installing
// only from the pinned dependency snapshot.
//
// A failed install is a FINDING ("does not build from a clean checkout with the declared
// steps"), often one of the most useful findings in due diligence, not a lane crash.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { hash } from "../core/determinism.js";
import type { FindingDraft } from "../findings/types.js";
import { ParseError, eslintAdapter, type SnippetReader } from "../normalize/adapters.js";
import { mypyAdapter, parseLcov, pct, sandboxRoot, tscAdapter, type Coverage } from "../normalize/sandbox-adapters.js";
import { CACHE_MOUNT, NODE_TOOLS_MOUNT, nodeInstall, pythonInstall, q, type NodeRecipe, type PythonRecipe } from "../sandbox/recipe.js";
import { imageRef, runSandbox, type Mount, type SandboxStep } from "../sandbox/runtime.js";
import { drivers, type AnalysisStep, type Driver, type InstallMode } from "../sandbox/stacks.js";
import { goCoverAdapter, goModulePath } from "../normalize/stack-adapters.js";
import { rawDir, type Lane, type LaneContext, type LaneOutcome, type LaneResult, type ToolRun } from "./lane.js";

const SANDBOX_TIMEOUT_MS = 30 * 60 * 1000;
const COVERAGE_RUNS = 2;
const VENV = ". /tmp/venv/bin/activate";

type Stack = string;

interface SandboxOutcome {
  readonly outcome: LaneOutcome;
  readonly out: string;
  readonly steps: ReadonlyMap<string, number>;
  readonly run: ToolRun;
  readonly detail?: string;
}

function readOut(out: string, file: string): string {
  const p = path.join(out, file);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

function snippetReader(root: string): SnippetReader {
  return (file, start, end) => {
    const abs = path.join(root, file);
    if (!existsSync(abs)) return null;
    return readFileSync(abs, "utf8").split(/\r?\n/).slice(start - 1, end).join("\n") || null;
  };
}

interface SandboxOpts {
  /** Image override (W5 stacks); default: the stack's pinned base image. */
  readonly image?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Steps that need no dependencies (static linters) can run without a dependency snapshot. */
  readonly needsDeps?: boolean;
}

/** Run install + steps for one stack in a fresh container; returns per-step exit codes. */
async function inSandbox(ctx: LaneContext, lane: string, stack: Stack, dir: string, install: string, steps: readonly SandboxStep[], opts: SandboxOpts = {}): Promise<SandboxOutcome> {
  const out = path.join(rawDir(ctx, lane), stack);
  mkdirSync(out, { recursive: true });
  const sb = ctx.tools.sandbox;
  const ref = path.relative(ctx.layout.dir, out).split(path.sep).join("/");
  const empty: ToolRun = { tool: `sandbox:${stack}`, exit_code: null, stdout_hash: hash(""), stderr_hash: hash(""), raw_ref: ref };
  if (sb === null) return { outcome: "tool-missing", out, steps: new Map(), run: empty, detail: "no container runtime (install Podman or Docker, then re-scope)" };
  const online = ctx.doc.network.mode === "network";
  if (!online && sb.depsCache === null && opts.needsDeps !== false) return { outcome: "tool-missing", out, steps: new Map(), run: empty, detail: "no dependency snapshot pinned (run `radr deps warm`, then re-scope)" };
  const image = opts.image ?? sb.images[stack] ?? imageRef(stack === "python" ? "python" : "node");

  const mounts: Mount[] = [
    { host: ctx.layout.worktree, container: "/src", readOnly: true },
    { host: out, container: "/radr/out", readOnly: false },
  ];
  if (stack === "typescript-javascript") mounts.push({ host: sb.nodeTools, container: NODE_TOOLS_MOUNT, readOnly: true });
  if (!online && sb.depsCache !== null) mounts.push({ host: sb.depsCache, container: CACHE_MOUNT, readOnly: true });

  const short: Readonly<Record<string, string>> = { "typescript-javascript": "js", python: "py", "java-kotlin": "jvm", csharp: "net" };
  const r = await runSandbox({
    runtime: sb.runtime, image,
    name: `radr-${ctx.layout.id}-${ctx.runId}-${lane}-${short[stack] ?? stack}-${String(ctx.attempt)}`.toLowerCase().slice(0, 120),
    network: online, mounts, workdir: dir, steps: [{ name: "install", command: install, required: true }, ...steps], timeoutMs: SANDBOX_TIMEOUT_MS,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  }, out);
  const run: ToolRun = { tool: `sandbox:${stack}`, exit_code: r.exec.exitCode, stdout_hash: r.exec.stdoutHash, stderr_hash: r.exec.stderrHash, raw_ref: ref };
  const stepCodes = new Map(r.steps.map((s) => [s.name, s.exitCode]));
  if (r.exec.outcome === "timeout") return { outcome: "timeout", out, steps: stepCodes, run, detail: `${stack} sandbox timed out` };
  if (r.exec.outcome !== "ok") {
    const why = r.exec.error ?? r.exec.stderr.toString().trim().split("\n").at(-1) ?? r.exec.outcome;
    return { outcome: /image not known|no such image|unable to find image/i.test(why) ? "tool-missing" : "tool-error", out, steps: stepCodes, run, detail: `${stack}: ${why}` };
  }
  return { outcome: "success", out, steps: stepCodes, run };
}

/** "Doesn't build from a clean checkout": one finding per stack, shared by every sandboxed lane. */
function buildFailed(ctx: LaneContext, stack: Stack, dir: string, out: string, rawRef: string, manifestName?: string): FindingDraft {
  const manifest = manifestName ?? (stack === "python" ? (ctx.doc.build?.python?.requirements[0] ?? "pyproject.toml") : "package.json");
  const file = dir === "." ? manifest : `${dir}/${manifest}`;
  const tail = readOut(out, "install.log").trim().split("\n").slice(-1)[0] ?? "";
  return {
    lane: "build", tool: "radr-build", tool_version: "1", rule_id: "install-failed", category: "maintainability", file, line: 0, end_line: 0,
    message: `${stack} dependencies do not install from a clean checkout with the declared steps (${ctx.doc.network.mode} mode)${tail === "" ? "" : `: ${tail.slice(0, 160)}`}`,
    tool_severity: "build-failed", snippet: null, engine_fingerprint: `build:${stack}:${dir}`, cve: null, aliases: [], cvss: null,
    raw_ref: `${rawRef}/install.log`, tags: [`stack:${stack}`],
  };
}

function installFor(stack: Stack, recipe: NodeRecipe | PythonRecipe, online: boolean): string {
  const mode = online ? "online" : "offline";
  return stack === "python" ? pythonInstall(recipe as PythonRecipe, mode) : nodeInstall(mode);
}

/** Combine per-stack results into a lane result: worst outcome wins; findings concatenate. */
function combine(parts: readonly { outcome: LaneOutcome; run?: ToolRun; findings: FindingDraft[]; detail?: string }[], metrics?: Record<string, unknown>): LaneResult {
  const rank: LaneOutcome[] = ["tool-missing", "version-drift", "tool-error", "timeout", "output-cap", "parse-error", "success"];
  const outcome = rank.find((o) => parts.some((p) => p.outcome === o)) ?? "success";
  const detail = [...new Set(parts.map((p) => p.detail).filter((d) => d !== undefined))].join("; ");
  return {
    outcome, tools: parts.flatMap((p) => (p.run === undefined ? [] : [p.run])), findings: parts.flatMap((p) => p.findings),
    ...(metrics !== undefined ? { metrics } : {}), ...(detail !== "" ? { detail } : {}),
  };
}

function stacksWithRecipe(ctx: LaneContext): { stack: Stack; recipe: NodeRecipe | PythonRecipe }[] {
  const b = ctx.doc.build ?? {};
  const out: { stack: Stack; recipe: NodeRecipe | PythonRecipe }[] = [];
  const node = b["typescript-javascript"];
  if (node !== undefined && ctx.doc.stacks.includes("typescript-javascript")) out.push({ stack: "typescript-javascript", recipe: node });
  if (b.python !== undefined && ctx.doc.stacks.includes("python")) out.push({ stack: "python", recipe: b.python });
  return out;
}

export const types: Lane = {
  id: "types",
  tools: ["sandbox", "node-tools"],
  async run(ctx) {
    const online = ctx.doc.network.mode === "network";
    const read = snippetReader(ctx.layout.worktree);
    const parts = [];
    for (const { stack, recipe } of stacksWithRecipe(ctx)) {
      const steps: SandboxStep[] = [];
      if (stack === "typescript-javascript") {
        const tsconfig = (recipe as NodeRecipe).tsconfig;
        if (tsconfig === null) continue;
        steps.push({ name: "typecheck", required: false,
          command: `if [ -x node_modules/.bin/tsc ]; then T=node_modules/.bin/tsc; else T="node ${NODE_TOOLS_MOUNT}/node_modules/typescript/bin/tsc"; fi; $T --noEmit --pretty false -p ${q(tsconfig)}` });
      } else {
        steps.push({ name: "typecheck", required: false, command: `${VENV} && mypy -O json --no-error-summary --ignore-missing-imports --no-incremental .` });
      }
      const s = await inSandbox(ctx, "types", stack, recipe.dir, installFor(stack, recipe, online), steps);
      if (s.outcome !== "success") { parts.push(s.detail === undefined ? { outcome: s.outcome, run: s.run, findings: [] } : { outcome: s.outcome, run: s.run, findings: [], detail: s.detail }); continue; }
      if (s.steps.get("install") !== 0) { parts.push({ outcome: "success" as const, run: s.run, findings: [buildFailed(ctx, stack, recipe.dir, s.out, s.run.raw_ref ?? "")] }); continue; }
      try {
        const log = readOut(s.out, "typecheck.log");
        const opts = { dir: recipe.dir, rawRef: `${s.run.raw_ref ?? ""}/typecheck.log`, toolVersion: stack === "python" ? "mypy" : "tsc", snippet: read };
        parts.push({ outcome: "success" as const, run: s.run, findings: stack === "python" ? mypyAdapter(log, opts) : tscAdapter(log, opts) });
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        parts.push({ outcome: "parse-error" as const, run: s.run, findings: [], detail: e.message });
      }
    }
    parts.push(...(await stackTypes(ctx)));
    return combine(parts);
  },
};

interface StackCoverage {
  readonly status: "stable" | "unstable" | "build-failed" | "no-tests" | "no-coverage";
  readonly runs: readonly { readonly exit: number | null; readonly coverage_hash: string | null }[];
  readonly line_pct: number | null;
  readonly branch_pct: number | null;
  readonly files: Readonly<Record<string, { readonly lines_found: number; readonly lines_hit: number }>>;
}

export const coverage: Lane = {
  id: "coverage",
  tools: ["sandbox", "node-tools"],
  async run(ctx) {
    const online = ctx.doc.network.mode === "network";
    const parts = [];
    const metrics: Record<string, StackCoverage> = {};
    for (const { stack, recipe } of stacksWithRecipe(ctx)) {
      const testSteps: SandboxStep[] = [];
      const node = stack === "typescript-javascript" ? (recipe as NodeRecipe) : undefined;
      const py = stack === "python" ? (recipe as PythonRecipe) : undefined;
      const hasTests = node !== undefined ? node.test !== null : py?.pytest_args !== null;
      if (!hasTests) {
        metrics[stack] = { status: "no-tests", runs: [], line_pct: null, branch_pct: null, files: {} };
        continue;
      }
      for (let n = 1; n <= COVERAGE_RUNS; n++) {
        const command = node !== undefined
          ? `mkdir -p /radr/out/cov${n} && node ${NODE_TOOLS_MOUNT}/node_modules/c8/bin/c8.js --reporter=lcovonly --reports-dir=/radr/out/cov${n} --temp-directory=/tmp/c8-${n} -- sh -c ${q(node.test ?? "true")}`
          : `${VENV} && mkdir -p /radr/out/cov${n} && coverage run --branch --data-file=/tmp/cov${n} -m pytest -p no:cacheprovider ${(py?.pytest_args ?? []).map(q).join(" ")}; rc=$?; coverage lcov --data-file=/tmp/cov${n} -o /radr/out/cov${n}/lcov.info >/dev/null 2>&1; exit $rc`;
        testSteps.push({ name: `test${n}`, command, required: false });
      }
      const s = await inSandbox(ctx, "coverage", stack, recipe.dir, installFor(stack, recipe, online), testSteps);
      if (s.outcome !== "success") { parts.push(s.detail === undefined ? { outcome: s.outcome, run: s.run, findings: [] } : { outcome: s.outcome, run: s.run, findings: [], detail: s.detail }); continue; }
      const ref = s.run.raw_ref ?? "";
      if (s.steps.get("install") !== 0) {
        metrics[stack] = { status: "build-failed", runs: [], line_pct: null, branch_pct: null, files: {} };
        parts.push({ outcome: "success" as const, run: s.run, findings: [buildFailed(ctx, stack, recipe.dir, s.out, ref)] });
        continue;
      }
      try {
        const runs: { exit: number | null; cov: Coverage | null }[] = [];
        for (let n = 1; n <= COVERAGE_RUNS; n++) {
          const lcov = readOut(s.out, `cov${n}/lcov.info`);
          runs.push({ exit: s.steps.get(`test${n}`) ?? null, cov: lcov.trim() === "" ? null : parseLcov(lcov, recipe.dir) });
        }
        const runHashes = runs.map((r) => ({ exit: r.exit, coverage_hash: r.cov === null ? null : hash(r.cov) }));
        const [firstRun] = runHashes;
        const stable = firstRun !== undefined && runHashes.every((r) => r.exit === firstRun.exit && r.coverage_hash === firstRun.coverage_hash);
        const first = runs[0]?.cov ?? null;
        const findings: FindingDraft[] = [];
        const anchor = stack === "python" ? (py?.requirements[0] ?? "pyproject.toml") : "package.json";
        const file = recipe.dir === "." ? anchor : `${recipe.dir}/${anchor}`;
        const finding = (rule: string, sev: string, message: string): FindingDraft => ({
          lane: "coverage", tool: "radr-coverage", tool_version: "1", rule_id: rule, category: "test", file, line: 0, end_line: 0, message,
          tool_severity: sev, snippet: null, engine_fingerprint: `coverage:${stack}:${rule}`, cve: null, aliases: [], cvss: null, raw_ref: `${ref}/test1.log`, tags: [`stack:${stack}`],
        });
        if (!stable) findings.push(finding("unstable-results", "flaky-test", `${stack} test results or coverage differ between ${COVERAGE_RUNS} identical runs (flaky tests or order-dependent state)`));
        if (runHashes.every((r) => r.exit !== 0)) findings.push(finding("tests-failed", "tests-failed", `${stack} test suite fails from a clean checkout (exit ${String(runHashes[0]?.exit)})`));
        const fileRows: Record<string, { lines_found: number; lines_hit: number }> = {};
        for (const [f, c] of Object.entries(first?.files ?? {})) fileRows[f] = { lines_found: c.lines_found, lines_hit: c.lines_hit };
        metrics[stack] = {
          status: first === null ? "no-coverage" : stable ? "stable" : "unstable", runs: runHashes,
          line_pct: first === null ? null : pct(first.totals.lines_hit, first.totals.lines_found),
          branch_pct: first === null ? null : pct(first.totals.branches_hit, first.totals.branches_found),
          files: fileRows,
        };
        parts.push({ outcome: "success" as const, run: s.run, findings });
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        parts.push({ outcome: "parse-error" as const, run: s.run, findings: [], detail: e.message });
      }
    }
    parts.push(...(await stackCoverage(ctx, metrics)));
    return combine(parts, { stacks: metrics });
  },
};

/** eslint with the CLIENT's config and plugins (needs the client's install, so it's sandboxed). */
export async function eslintProject(ctx: LaneContext): Promise<{ outcome: LaneOutcome; run?: ToolRun; findings: FindingDraft[]; detail?: string }> {
  const recipe = ctx.doc.build?.["typescript-javascript"];
  if (recipe === undefined) return { outcome: "success", findings: [], detail: "eslint project mode: no TS/JS build recipe" };
  const online = ctx.doc.network.mode === "network";
  const s = await inSandbox(ctx, "lint", "typescript-javascript", recipe.dir, nodeInstall(online ? "online" : "offline"), [
    { name: "eslint", required: false, command: "if [ -x node_modules/.bin/eslint ]; then node_modules/.bin/eslint -f json . > /radr/out/eslint-project.json; else echo NO_CLIENT_ESLINT; fi" },
  ]);
  if (s.outcome !== "success") return s.detail === undefined ? { outcome: s.outcome, run: s.run, findings: [] } : { outcome: s.outcome, run: s.run, findings: [], detail: s.detail };
  if (s.steps.get("install") !== 0) return { outcome: "success", run: s.run, findings: [buildFailed(ctx, "typescript-javascript", recipe.dir, s.out, s.run.raw_ref ?? "")] };
  if (readOut(s.out, "eslint.log").includes("NO_CLIENT_ESLINT")) return { outcome: "success", run: s.run, findings: [], detail: "eslint project mode: the client has no eslint installed" };
  const code = s.steps.get("eslint");
  if (code !== 0 && code !== 1) return { outcome: "tool-error", run: s.run, findings: [], detail: `client eslint exited ${String(code)}: ${readOut(s.out, "eslint.log").trim().split("\n").at(-1) ?? ""}` };
  try {
    const raw = readOut(s.out, "eslint-project.json");
    return {
      outcome: "success", run: s.run,
      findings: eslintAdapter({ raw, rawRef: `${s.run.raw_ref ?? ""}/eslint-project.json`, repoRoot: sandboxRoot("."), toolVersion: "client", snippet: snippetReader(ctx.layout.worktree) }, "project")

    };
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    return { outcome: "parse-error", run: s.run, findings: [], detail: e.message };
  }
}

// --- M3 W5 stacks (drivers: src/sandbox/stacks.ts) ------------------------------------------------

type Part = { outcome: LaneOutcome; run?: ToolRun; findings: FindingDraft[]; detail?: string };

function driverMode(ctx: LaneContext): InstallMode {
  return ctx.doc.network.mode === "network" ? "online" : "offline";
}

/** One analysis step for one W5 stack: sandbox → install (if needed) → step → parse. */
async function analyze(ctx: LaneContext, lane: string, d: Driver, dir: string, step: AnalysisStep, dotnetSdk: string): Promise<Part> {
  const mode = driverMode(ctx);
  const image = ctx.tools.sandbox?.images[d.stack === "csharp" ? `csharp-${dotnetSdk}` : d.stack];
  const s = await inSandbox(ctx, lane, d.stack, dir, step.needsInstall ? d.install(mode) : "true",
    [{ name: step.name, command: step.command, required: false }], { env: d.env(mode), needsDeps: step.needsInstall, ...(image !== undefined ? { image } : {}) });
  if (s.outcome !== "success") return s.detail === undefined ? { outcome: s.outcome, run: s.run, findings: [] } : { outcome: s.outcome, run: s.run, findings: [], detail: s.detail };
  const ref = s.run.raw_ref ?? "";
  if (s.steps.get("install") !== 0) return { outcome: "success", run: s.run, findings: [buildFailed(ctx, d.stack, dir, s.out, ref, d.manifest)] };
  const code = s.steps.get(step.name);
  const file = step.output ?? `${step.name}.log`;
  const text = readOut(s.out, file);
  if (step.output !== null && text.trim() === "") {
    return { outcome: "tool-error", run: s.run, findings: [], detail: `${step.tool} (${d.stack}) wrote no output (exit ${String(code)}): ${readOut(s.out, `${step.name}.log`).trim().split("\n").at(-1) ?? ""}` };
  }
  try {
    return { outcome: "success", run: s.run, findings: step.parse(text, { dir, rawRef: `${ref}/${file}`, toolVersion: step.tool, snippet: snippetReader(ctx.layout.worktree) }) };
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    return { outcome: "parse-error", run: s.run, findings: [], detail: e.message };
  }
}

/** Type-check steps of the W5 stacks (types lane). */
export async function stackTypes(ctx: LaneContext): Promise<Part[]> {
  const parts: Part[] = [];
  for (const { driver, recipe, dotnetSdk } of drivers(ctx.doc.build, ctx.doc.stacks, ctx.doc.network.mode === "network")) {
    const step = driver.typecheck();
    if (step !== null) parts.push(await analyze(ctx, "types", driver, recipe.dir, step, dotnetSdk));
  }
  return parts;
}

/** Sandboxed linters of the W5 stacks (lint lane, baseline mode). Skipped, with a note, without a runtime. */
export interface StackLint {
  readonly parts: Part[];
  /** Stacks whose linter ran to a parsed result. */
  readonly linted: string[];
  /** Sandboxed-linter stacks in scope that weren't linted, and why (coverage, M6 dogfood). */
  readonly skipped: { stack: string; why: string }[];
}

const SANDBOX_LINT_STACKS = ["go", "rust", "java-kotlin", "php", "ruby", "csharp"];

/** Every sandbox-linter stack in scope, skipped for one reason. */
export function stackLintSkipped(ctx: LaneContext, why: string): StackLint {
  return { parts: [], linted: [], skipped: ctx.doc.stacks.filter((s) => SANDBOX_LINT_STACKS.includes(s)).map((stack) => ({ stack, why })) };
}

export async function stackLint(ctx: LaneContext): Promise<StackLint> {
  const ds = drivers(ctx.doc.build, ctx.doc.stacks, ctx.doc.network.mode === "network").filter((x) => x.driver.lint() !== null);
  const withRecipe = new Set(ds.map((x) => x.driver.stack as string));
  const noRecipe = ctx.doc.stacks.filter((s) => SANDBOX_LINT_STACKS.includes(s) && !withRecipe.has(s))
    .map((stack) => ({ stack, why: "the stack's build environment wasn't set up for this review" }));
  // The consultant-facing how-to-fix goes in the lane detail; the report states the gap neutrally.
  const hint = noRecipe.length > 0 ? [{ outcome: "success" as const, findings: [], detail: `${noRecipe.map((x) => x.stack).join(", ")}: no build recipe, so no sandboxed linter (re-scope with Podman or Docker running so radr can propose one)` }] : [];
  if (ds.length === 0) return { parts: hint, linted: [], skipped: noRecipe };
  if (ctx.tools.sandbox === null) {
    return {
      parts: [{ outcome: "success", findings: [], detail: `${ds.map((x) => x.driver.stack).join(", ")} linters need the build sandbox (no container runtime)` }],
      linted: [], skipped: [...noRecipe, ...ds.map((x) => ({ stack: x.driver.stack, why: "the stack's build environment wasn't available for this review" }))],
    };
  }
  const parts: Part[] = [...hint];
  const linted: string[] = [];
  const skipped = [...noRecipe];
  for (const { driver, recipe, dotnetSdk } of ds) {
    const step = driver.lint();
    if (step === null) continue;
    const p = await analyze(ctx, "lint", driver, recipe.dir, step, dotnetSdk);
    parts.push(p);
    if (p.outcome === "success") linted.push(driver.stack);
    else skipped.push({ stack: driver.stack, why: `the linter ended ${p.outcome}` });
  }
  return { parts, linted, skipped };
}

/** Tests (and, for Go, statement coverage) of the W5 stacks (coverage lane). */
export async function stackCoverage(ctx: LaneContext, metrics: Record<string, StackCoverage>): Promise<Part[]> {
  const mode = driverMode(ctx);
  const parts: Part[] = [];
  for (const { driver: d, recipe, dotnetSdk } of drivers(ctx.doc.build, ctx.doc.stacks, ctx.doc.network.mode === "network")) {
    if (d.test(1) === null) {
      metrics[d.stack] = { status: "no-tests", runs: [], line_pct: null, branch_pct: null, files: {} };
      continue;
    }
    const steps: SandboxStep[] = [];
    for (let n = 1; n <= COVERAGE_RUNS; n++) steps.push({ name: `test${String(n)}`, command: d.test(n) ?? "true", required: false });
    const image = ctx.tools.sandbox?.images[d.stack === "csharp" ? `csharp-${dotnetSdk}` : d.stack];
    const s = await inSandbox(ctx, "coverage", d.stack, recipe.dir, d.install(mode), steps, { env: d.env(mode), ...(image !== undefined ? { image } : {}) });
    if (s.outcome !== "success") { parts.push(s.detail === undefined ? { outcome: s.outcome, run: s.run, findings: [] } : { outcome: s.outcome, run: s.run, findings: [], detail: s.detail }); continue; }
    const ref = s.run.raw_ref ?? "";
    if (s.steps.get("install") !== 0) {
      metrics[d.stack] = { status: "build-failed", runs: [], line_pct: null, branch_pct: null, files: {} };
      parts.push({ outcome: "success", run: s.run, findings: [buildFailed(ctx, d.stack, recipe.dir, s.out, ref, d.manifest)] });
      continue;
    }
    try {
      const covs: (Coverage | null)[] = [];
      for (let n = 1; n <= COVERAGE_RUNS; n++) {
        if (d.stack !== "go") { covs.push(null); continue; }
        const profile = readOut(s.out, `cov${String(n)}/cover.out`);
        const goMod = readOut(path.join(ctx.layout.worktree, recipe.dir), "go.mod");
        covs.push(profile.trim() === "" ? null : goCoverAdapter(profile, goModulePath(goMod), recipe.dir));
      }
      const runHashes = covs.map((c, i) => ({ exit: s.steps.get(`test${String(i + 1)}`) ?? null, coverage_hash: c === null ? null : hash(c) }));
      const [firstRun] = runHashes;
      const stable = firstRun !== undefined && runHashes.every((r) => r.exit === firstRun.exit && r.coverage_hash === firstRun.coverage_hash);
      const first = covs[0] ?? null;
      const file = recipe.dir === "." ? d.manifest : `${recipe.dir}/${d.manifest}`;
      const finding = (rule: string, sev: string, message: string): FindingDraft => ({
        lane: "coverage", tool: "radr-coverage", tool_version: "1", rule_id: rule, category: "test", file, line: 0, end_line: 0, message,
        tool_severity: sev, snippet: null, engine_fingerprint: `coverage:${d.stack}:${rule}`, cve: null, aliases: [], cvss: null, raw_ref: `${ref}/test1.log`, tags: [`stack:${d.stack}`],
      });
      const findings: FindingDraft[] = [];
      if (!stable) findings.push(finding("unstable-results", "flaky-test", `${d.stack} test results${d.stack === "go" ? " or coverage" : ""} differ between ${String(COVERAGE_RUNS)} identical runs (flaky tests or order-dependent state)`));
      if (runHashes.every((r) => r.exit !== 0)) findings.push(finding("tests-failed", "tests-failed", `${d.stack} test suite fails from a clean checkout (exit ${String(runHashes[0]?.exit)})`));
      const fileRows: Record<string, { lines_found: number; lines_hit: number }> = {};
      for (const [f, c] of Object.entries(first?.files ?? {})) fileRows[f] = { lines_found: c.lines_found, lines_hit: c.lines_hit };
      metrics[d.stack] = {
        status: stable ? "stable" : "unstable", runs: runHashes,
        line_pct: first === null ? null : pct(first.totals.lines_hit, first.totals.lines_found), branch_pct: null, files: fileRows,
      };
      parts.push({ outcome: "success", run: s.run, findings });
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      parts.push({ outcome: "parse-error", run: s.run, findings: [], detail: e.message });
    }
  }
  return parts;
}
