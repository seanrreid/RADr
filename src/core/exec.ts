// The only way radr runs external programs (T0.4). Never uses a shell, never inherits the
// ambient environment wholesale, always bounds time and output, and hashes what it captured.

import { spawn } from "node:child_process";
import { hashBytes } from "./determinism.js";

/** Pinned locale/timezone for every tool, so tool output can't vary by host settings. */
const DETERMINISTIC_ENV: Readonly<Record<string, string>> = { LC_ALL: "C", LANG: "C", TZ: "UTC" };
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const KILL_GRACE_MS = 2000;

export interface ExecRequest {
  /** Absolute path (preferred) or a name resolved via the allowlisted PATH. */
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Names of host env vars to pass through (e.g. ["PATH", "HOME"]). Nothing else is inherited. */
  readonly inheritEnv?: readonly string[];
  /** Explicit env values; override inherited and deterministic defaults. */
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  /** Combined stdout+stderr cap. Exceeding it kills the process: output is never silently truncated. */
  readonly maxOutputBytes?: number;
  /** Exit codes that count as a valid run (e.g. gitleaks exits 1 when it finds leaks). Default [0]. */
  readonly okExitCodes?: readonly number[];
}

export type ExecOutcome = "ok" | "nonzero-exit" | "timeout" | "output-cap" | "tool-missing" | "spawn-error";

export interface ExecResult {
  readonly outcome: ExecOutcome;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly stdoutHash: string;
  readonly stderrHash: string;
  /** Present for tool-missing / spawn-error. */
  readonly error?: string;
}

export function buildEnv(req: Pick<ExecRequest, "inheritEnv" | "env">, host: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { ...DETERMINISTIC_ENV };
  for (const name of req.inheritEnv ?? []) {
    const v = host[name];
    if (v !== undefined) env[name] = v;
  }
  return { ...env, ...req.env };
}

export function run(req: ExecRequest): Promise<ExecResult> {
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutput = req.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const okCodes = req.okExitCodes ?? [0];

  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let capped = false;
    let timedOut = false;
    let settled = false;

    const child = spawn(req.command, [...req.args], {
      cwd: req.cwd,
      env: buildEnv(req),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const kill = (): void => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);

    const collect = (sink: Buffer[]) => (chunk: Buffer) => {
      if (capped) return;
      bytes += chunk.length;
      if (bytes > maxOutput) {
        capped = true;
        kill();
        return;
      }
      sink.push(chunk);
    };
    child.stdout.on("data", collect(out));
    child.stderr.on("data", collect(err));

    const finish = (partial: Pick<ExecResult, "outcome" | "exitCode" | "signal"> & { error?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(out);
      const stderr = Buffer.concat(err);
      resolve({ ...partial, stdout, stderr, stdoutHash: hashBytes(stdout), stderrHash: hashBytes(stderr) });
    };

    child.on("error", (e: NodeJS.ErrnoException) => {
      const outcome: ExecOutcome = e.code === "ENOENT" ? "tool-missing" : "spawn-error";
      finish({ outcome, exitCode: null, signal: null, error: `${req.command}: ${e.message}` });
    });

    child.on("close", (code, signal) => {
      let outcome: ExecOutcome;
      if (timedOut) outcome = "timeout";
      else if (capped) outcome = "output-cap";
      else if (code !== null && okCodes.includes(code)) outcome = "ok";
      else outcome = "nonzero-exit";
      finish({ outcome, exitCode: code, signal });
    });
  });
}
