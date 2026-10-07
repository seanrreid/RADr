// The single gate in front of RADR_AGENT_CMD (PRD §9). Every agent call goes through
// invokeAgent: the policy is checked BEFORE a process is spawned, every prompt and response is
// persisted under llm/ with an `llm-call` event whose hashes match the files, and the response
// must validate against the caller's schema. What happens after a failed call is decided by the
// `llm` row of policy/matrix.yml, never here.
//
// The agent gets no ambient access: no shell, an empty temp cwd, and an environment of PATH,
// HOME, and only the variables named in RADR_AGENT_ENV.
//
// Agent-agnostic wiring: an argv element "{schema}" is replaced by the call's JSON Schema
// (Claude Code: --json-schema {schema}), and RADR_AGENT_OUTPUT says how to read stdout:
// "raw" (default, stdout is the JSON document) or "claude-json" (Claude Code's
// --output-format json envelope: the document is `structured_output`, or `result` as JSON).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalJson, hash, hashBytes } from "../core/determinism.js";
import { RadrError, RefusedError, UsageError } from "../core/errors.js";
import { run, type ExecResult } from "../core/exec.js";
import type { EngagementDoc } from "../engagement/config.js";
import type { Matrix } from "../matrix/matrix.js";
import { makeValidator, type Validator } from "../schemas/validate.js";
import type { AnySchema } from "ajv";
import type { EventLog } from "../state/events.js";

export type LlmPolicy = EngagementDoc["llm_policy"];

export interface AgentRequest {
  /** What the call is for (a slug, recorded in the event): "triage-explain", "draft-summary", … */
  readonly purpose: string;
  /** The full prompt, already filtered for the policy (W1). Sent on stdin, persisted verbatim. */
  readonly prompt: string;
  /** The response's JSON Schema: sent to the agent via {schema}, and enforced here. */
  readonly schema: AnySchema;
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
    // Arguments may be empty (Claude Code's `--tools ""`); the executable may not.
    if (!Array.isArray(argv) || !argv.every((a): a is string => typeof a === "string") || (argv[0] ?? "") === "") {
      throw new UsageError("RADR_AGENT_CMD: expected a JSON array of strings whose first element names the executable");
    }
    return argv;
  }
  if (/\s/.test(raw)) throw new UsageError("RADR_AGENT_CMD: no shell is used, so arguments must be a JSON argv array, e.g. [\"claude\", \"-p\"]");
  return [raw];
}

export type AgentOutput = "raw" | "claude-json";

export function parseAgentOutput(env: NodeJS.ProcessEnv): AgentOutput {
  const v = env["RADR_AGENT_OUTPUT"] ?? "";
  if (v === "" || v === "raw") return "raw";
  if (v === "claude-json") return "claude-json";
  throw new UsageError(`RADR_AGENT_OUTPUT: "${v}" (expected raw or claude-json)`);
}

/** The response document inside stdout, per RADR_AGENT_OUTPUT. Throws a string on a bad shape. */
function unwrap(stdout: string, mode: AgentOutput): unknown {
  const doc: unknown = JSON.parse(stdout);
  if (mode === "raw") return doc;
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw new Error("claude-json: stdout is not an object");
  const env = doc as Record<string, unknown>;
  if (env["is_error"] === true) throw new Error(`claude-json: agent reported an error (${typeof env["subtype"] === "string" ? env["subtype"] : "unknown"})`);
  if (env["structured_output"] !== undefined) return env["structured_output"];
  if (typeof env["result"] === "string") return JSON.parse(env["result"]);
  throw new Error("claude-json: neither structured_output nor result");
}

const validators = new Map<string, Validator<unknown>>();
function validatorFor(schema: AnySchema): Validator<unknown> {
  const key = hash(schema);
  let v = validators.get(key);
  if (v === undefined) {
    v = makeValidator<unknown>(schema, RefusedError);
    validators.set(key, v);
  }
  return v;
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
function classify<T>(r: ExecResult, validate: Validator<T>, mode: AgentOutput): { outcome: string; detail: string; output?: T } {
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
    parsed = unwrap(r.stdout.toString("utf8"), mode);
  } catch (e) {
    return { outcome: "fail-protocol", detail: e instanceof SyntaxError ? "response is not JSON" : (e as Error).message };
  }
  try {
    return { outcome: "success", detail: "", output: validate(parsed, "agent response") };
  } catch (e) {
    if (e instanceof RadrError) return { outcome: "fail-protocol", detail: e.message };
    throw e;
  }
}

export async function invokeAgent<T>(ctx: AgentContext, req: AgentRequest): Promise<AgentResult<T>> {
  if (ctx.policy === "off") {
    throw new RefusedError(`LLM policy is "off" for this engagement; refusing agent call (${req.purpose})`);
  }
  const argv = parseAgentCmd(ctx.env);
  if (argv === null) throw new RefusedError(`RADR_AGENT_CMD is not set; refusing agent call (${req.purpose})`);
  const schemaText = canonicalJson(req.schema);
  const [command, ...args] = argv.map((a) => (a === "{schema}" ? schemaText : a));
  if (command === undefined) throw new RefusedError("RADR_AGENT_CMD is empty");
  const mode = parseAgentOutput(ctx.env);
  const validate = validatorFor(req.schema) as Validator<T>;
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

    const c = classify(r, validate, mode);
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
