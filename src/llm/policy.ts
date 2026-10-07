// The single gate in front of RADR_AGENT_CMD (PRD §9). Every agent call goes through
// invokeAgent: the policy is checked BEFORE a process is spawned, every prompt and response is
// persisted under llm/ with an `llm-call` event whose hashes match the files, and the response
// must validate against the caller's schema. What happens after a failed call is decided by the
// `llm` row of policy/matrix.yml, never here.
//
// The agent gets no ambient access: no shell, an empty temp cwd, and an environment of PATH,
// HOME, and only the variables named in RADR_AGENT_ENV.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hash, hashBytes } from "../core/determinism.js";
import { RadrError, RefusedError, UsageError } from "../core/errors.js";
import { run, type ExecResult } from "../core/exec.js";
import type { EngagementDoc } from "../engagement/config.js";
import type { Matrix } from "../matrix/matrix.js";
import type { Validator } from "../schemas/validate.js";
import type { EventLog } from "../state/events.js";

export type LlmPolicy = EngagementDoc["llm_policy"];

export interface AgentRequest<T> {
  /** What the call is for (a slug, recorded in the event): "triage-explain", "draft-summary", … */
  readonly purpose: string;
  /** The full prompt, already filtered for the policy (W1). Sent on stdin, persisted verbatim. */
  readonly prompt: string;
  /** Validates the parsed response; any throw is a `fail-protocol` outcome. */
  readonly validate: Validator<T>;
}

export interface AgentContext {
  readonly policy: LlmPolicy;
  readonly env: NodeJS.ProcessEnv;
  /** The engagement's llm/ directory. */
  readonly llmDir: string;
  readonly log: EventLog;
  readonly actor: string;
  readonly matrix: Matrix;
  readonly timeoutMs?: number;
}

export type AgentResult<T> =
  | { readonly status: "ok"; readonly output: T; readonly callIds: readonly string[] }
  | { readonly status: "partial" | "abort"; readonly outcome: string; readonly detail: string; readonly callIds: readonly string[] };

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PURPOSE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * RADR_AGENT_CMD: a JSON array of argv (`["claude", "-p", …]`), or a single executable path.
 * Unset or empty ⇒ null: no LLM, by construction.
 */
export function parseAgentCmd(env: NodeJS.ProcessEnv): string[] | null {
  const raw = (env["RADR_AGENT_CMD"] ?? "").trim();
  if (raw === "") return null;
  if (raw.startsWith("[")) {
    let argv: unknown;
    try {
      argv = JSON.parse(raw);
    } catch {
      throw new UsageError("RADR_AGENT_CMD: not valid JSON (expected an argv array, e.g. [\"claude\", \"-p\"])");
    }
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a): a is string => typeof a === "string" && a !== "")) {
      throw new UsageError("RADR_AGENT_CMD: expected a non-empty JSON array of non-empty strings");
    }
    return argv;
  }
  if (/\s/.test(raw)) throw new UsageError("RADR_AGENT_CMD: no shell is used, so arguments must be a JSON argv array, e.g. [\"claude\", \"-p\"]");
  return [raw];
}

/** PATH and HOME, plus the names listed (comma- or space-separated) in RADR_AGENT_ENV. */
export function agentEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const names = ["PATH", "HOME", ...(env["RADR_AGENT_ENV"] ?? "").split(/[\s,]+/).filter((n) => n !== "")];
  const out: Record<string, string> = {};
  for (const n of names) {
    if (!ENV_NAME.test(n)) throw new UsageError(`RADR_AGENT_ENV: "${n}" is not an environment variable name`);
    const v = env[n];
    if (v !== undefined) out[n] = v;
  }
  return out;
}

/** The exec result (and, on success, the parsed response) as a matrix outcome. */
function classify<T>(r: ExecResult, validate: Validator<T>): { outcome: string; detail: string; output?: T } {
  switch (r.outcome) {
    case "ok":
      break;
    case "tool-missing":
      return { outcome: "tool-missing", detail: r.error ?? "agent command not found" };
    case "timeout":
    case "output-cap":
      return { outcome: r.outcome, detail: "" };
    case "nonzero-exit":
    case "spawn-error":
      return { outcome: "tool-error", detail: r.error ?? `exit ${String(r.exitCode)}: ${r.stderr.toString().trim().slice(-300)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout.toString("utf8"));
  } catch {
    return { outcome: "fail-protocol", detail: "response is not JSON" };
  }
  try {
    return { outcome: "success", detail: "", output: validate(parsed, "agent response") };
  } catch (e) {
    if (e instanceof RadrError) return { outcome: "fail-protocol", detail: e.message };
    throw e;
  }
}

export async function invokeAgent<T>(ctx: AgentContext, req: AgentRequest<T>): Promise<AgentResult<T>> {
  if (ctx.policy === "off") {
    throw new RefusedError(`LLM policy is "off" for this engagement; refusing agent call (${req.purpose})`);
  }
  const argv = parseAgentCmd(ctx.env);
  if (argv === null) throw new RefusedError(`RADR_AGENT_CMD is not set; refusing agent call (${req.purpose})`);
  const [command, ...args] = argv;
  if (command === undefined) throw new RefusedError("RADR_AGENT_CMD is empty");
  if (!PURPOSE.test(req.purpose)) throw new RefusedError(`agent call purpose "${req.purpose}" is not a slug`);
  const env = agentEnv(ctx.env);

  mkdirSync(ctx.llmDir, { recursive: true });
  const callIds: string[] = [];
  for (let attempt = 1; ; attempt++) {
    const n = ctx.log.read().filter((e) => e.type === "llm-call").length + 1;
    const callId = `L-${String(n).padStart(4, "0")}`;
    callIds.push(callId);
    // Persist the prompt BEFORE it leaves the machine, so even a crash mid-call is auditable.
    writeFileSync(path.join(ctx.llmDir, `${callId}.prompt.txt`), req.prompt);

    const cwd = mkdtempSync(path.join(tmpdir(), "radr-agent-"));
    let r: ExecResult;
    try {
      r = await run({ command, args, cwd, env, stdin: req.prompt, timeoutMs: ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
    writeFileSync(path.join(ctx.llmDir, `${callId}.response.txt`), r.stdout);

    const c = classify(r, req.validate);
    const resolved = ctx.matrix.resolve("llm", c.outcome, attempt);
    const action = c.outcome === "success" ? "continue" : resolved.action;
    ctx.log.append("llm-call", ctx.actor, {
      call_id: callId, purpose: req.purpose, policy: ctx.policy, attempt,
      argv_hash: hash(argv), prompt_hash: hashBytes(req.prompt), response_hash: r.stdoutHash,
      outcome: c.outcome, action, ...(c.detail === "" ? {} : { detail: c.detail }),
    });
    if (c.output !== undefined) return { status: "ok", output: c.output, callIds };
    if (resolved.action === "retry") continue;
    if (resolved.action === "continue") throw new RefusedError(`matrix: (llm, ${c.outcome}) resolved to continue without a response`);
    return { status: resolved.action, outcome: c.outcome, detail: c.detail, callIds };
  }
}
