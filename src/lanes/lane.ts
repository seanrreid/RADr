// Lane contract (T4.1). A lane runs its tools against the read-only worktree, stores their
// untouched output under raw/, and returns typed drafts. It never decides what happens next:
// the runner resolves its outcome through policy/matrix.yml.

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { hashBytes } from "../core/determinism.js";
import type { ExecOutcome, ExecResult } from "../core/exec.js";
import type { EngagementDoc } from "../engagement/config.js";
import type { Layout } from "../engagement/home.js";
import type { FindingDraft } from "../findings/types.js";
import type { Runtime } from "../sandbox/runtime.js";
import type { Exec } from "../toolchain/container.js";

export type LaneOutcome = "success" | "tool-missing" | "version-drift" | "tool-error" | "timeout" | "output-cap" | "parse-error";

export interface ToolRun {
  readonly tool: string;
  readonly exit_code: number | null;
  readonly stdout_hash: string;
  readonly stderr_hash: string;
  readonly raw_ref?: string;
}

export interface Toolbox {
  /** Absolute path of a manifest tool's binary, keyed by tool name. */
  readonly bins: Readonly<Record<string, string>>;
  readonly versions: Readonly<Record<string, string>>;
  /** node-tools install dir (eslint + baseline config). */
  readonly nodeTools: string;
  /** Absolute path of the node binary running radr (used to run eslint). */
  readonly node: string;
  /** OSV snapshot directory for OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY, if pinned. */
  readonly osvDb: string | null;
  /** Python interpreter for the Python tools (lizard; checkov and scancode have their own bins in the image). */
  readonly python: string;
  /** PYTHONPATH for host-installed Python tools (pip --target dir); null in the image (a venv). */
  readonly pythonPath: string | null;
  /** Absolute path of radr's ruff baseline config. */
  readonly ruffConfig: string;
  /** radr's rules/ directory (pack + lgpl sub-pack); mounted read-only at the same path in container mode. */
  readonly rulesDir: string;
  /** Runs a tool: on the host, or in the toolchain image with --network=none (container mode). */
  readonly exec: Exec;
  /** Build sandbox (M2): runtime + offline dependency cache. null = no runtime detected. */
  readonly sandbox: {
    readonly runtime: Runtime;
    readonly depsCache: string | null;
    /** HOST node-tools dir (mounted into sandboxes). */
    readonly nodeTools: string;
    /** Sandbox image per W5 stack (locally built stack images, .NET SDK by major). */
    readonly images: Readonly<Record<string, string>>;
  } | null;
}

export interface LaneContext {
  readonly layout: Layout;
  readonly doc: EngagementDoc;
  readonly runId: string;
  readonly attempt: number;
  readonly tools: Toolbox;
  /** Metrics from lanes that already completed in this run (e.g. census → history, tests). */
  readonly metrics: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export interface LaneResult {
  readonly outcome: LaneOutcome;
  readonly tools: readonly ToolRun[];
  readonly findings: readonly FindingDraft[];
  /** Lane metrics (e.g., census) — integers/strings only. */
  readonly metrics?: Readonly<Record<string, unknown>>;
  readonly detail?: string;
}

export interface Lane {
  readonly id: string;
  readonly tools: readonly string[];
  run(ctx: LaneContext): Promise<LaneResult>;
}

export function execOutcome(o: ExecOutcome): LaneOutcome {
  switch (o) {
    case "ok": return "success";
    case "tool-missing": return "tool-missing";
    case "timeout": return "timeout";
    case "output-cap": return "output-cap";
    case "nonzero-exit":
    case "spawn-error": return "tool-error";
  }
}

/** raw/<run>/<lane>/ (attempt-specific so retries never overwrite earlier evidence). */
export function rawDir(ctx: LaneContext, lane: string): string {
  const dir = path.join(ctx.layout.raw, ctx.runId, `${lane}.attempt-${ctx.attempt}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Store a tool's stdout untouched and return its ToolRun record. raw_ref is engagement-relative. */
export function recordRun(ctx: LaneContext, lane: string, tool: string, file: string, r: ExecResult): ToolRun {
  const abs = path.join(rawDir(ctx, lane), file);
  writeFileSync(abs, r.stdout);
  if (r.stderr.length > 0) writeFileSync(`${abs}.stderr`, r.stderr);
  return {
    tool,
    exit_code: r.exitCode,
    stdout_hash: r.stdoutHash,
    stderr_hash: r.stderrHash,
    raw_ref: path.relative(ctx.layout.dir, abs).split(path.sep).join("/"),
  };
}

/** For tools that write their report to a file: hash the file, not stdout. */
export function recordFileRun(ctx: LaneContext, tool: string, reportAbs: string, data: Buffer, r: ExecResult): ToolRun {
  return {
    tool,
    exit_code: r.exitCode,
    stdout_hash: hashBytes(data),
    stderr_hash: r.stderrHash,
    raw_ref: path.relative(ctx.layout.dir, reportAbs).split(path.sep).join("/"),
  };
}

/** Deterministic tool env: no inherited HOME/config; caches pointed at the engagement. */
export function toolEnv(ctx: LaneContext, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return { HOME: path.join(ctx.layout.cache, "home"), XDG_CACHE_HOME: path.join(ctx.layout.cache, "xdg"), PATH: "/usr/bin:/bin", ...extra };
}
