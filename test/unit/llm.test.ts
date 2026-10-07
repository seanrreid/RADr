import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixedClock } from "../../src/core/clock.js";
import { hash, hashBytes } from "../../src/core/determinism.js";
import { RefusedError, UsageError } from "../../src/core/errors.js";
import { agentEnv, invokeAgent, parseAgentCmd, type AgentContext, type LlmPolicy } from "../../src/llm/policy.js";
import { Matrix } from "../../src/matrix/matrix.js";
import { makeValidator } from "../../src/schemas/validate.js";
import { EventLog } from "../../src/state/events.js";
import { engagementHash } from "../../src/state/fingerprint.js";
import { parseEngagement } from "../../src/engagement/config.js";
import { tmpDir } from "../helpers/tmp.js";

const fakeAgent = path.join(path.dirname(fileURLToPath(import.meta.url)), "../helpers/fake-agent.js");
const validate = makeValidator<{ answer: string }>(
  { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string" } } },
  RefusedError,
);

/** An engagement-like dir with a scripted fake agent: responses[i] / exits[i] script call i+1. */
function setup(responses: readonly string[], exits: readonly number[] = [], policy: LlmPolicy = "metadata-only", extraEnv: NodeJS.ProcessEnv = {}) {
  const dir = tmpDir();
  const script = tmpDir("radr-agent-script-");
  responses.forEach((r, i) => { writeFileSync(path.join(script, `response-${String(i + 1)}`), r); });
  exits.forEach((x, i) => { writeFileSync(path.join(script, `exit-${String(i + 1)}`), String(x)); });
  const log = new EventLog(path.join(dir, "events.jsonl"), fixedClock("2026-10-07T00:00:00.000Z"));
  const ctx: AgentContext = {
    policy, log, actor: "test", matrix: Matrix.load(), llmDir: path.join(dir, "llm"),
    env: { PATH: process.env["PATH"], HOME: "/home/nobody", SECRET_TOKEN: "do-not-leak", RADR_AGENT_CMD: JSON.stringify([process.execPath, fakeAgent, script]), ...extraEnv },
  };
  const calls = () => (existsSync(path.join(script, "count")) ? Number(readFileSync(path.join(script, "count"), "utf8")) : 0);
  return { ctx, log, script, calls, llmDir: ctx.llmDir };
}

describe("RADR_AGENT_CMD and RADR_AGENT_ENV", () => {
  it("parses a JSON argv array or a single executable path; unset means no LLM", () => {
    assert.deepEqual(parseAgentCmd({ RADR_AGENT_CMD: '["claude", "-p", "--output-format", "json"]' }), ["claude", "-p", "--output-format", "json"]);
    assert.deepEqual(parseAgentCmd({ RADR_AGENT_CMD: "/usr/local/bin/agent" }), ["/usr/local/bin/agent"]);
    assert.equal(parseAgentCmd({}), null);
    assert.equal(parseAgentCmd({ RADR_AGENT_CMD: "  " }), null);
  });
  it("rejects shell-style strings and malformed arrays", () => {
    assert.throws(() => parseAgentCmd({ RADR_AGENT_CMD: "claude -p" }), /JSON argv array/);
    assert.throws(() => parseAgentCmd({ RADR_AGENT_CMD: "[\"claude\"," }), UsageError);
    assert.throws(() => parseAgentCmd({ RADR_AGENT_CMD: "[]" }), UsageError);
    assert.throws(() => parseAgentCmd({ RADR_AGENT_CMD: "[\"claude\", 1]" }), UsageError);
  });
  it("passes only PATH, HOME and the names in RADR_AGENT_ENV", () => {
    const env = { PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "k", OTHER: "x", RADR_AGENT_ENV: "ANTHROPIC_API_KEY, MISSING" };
    assert.deepEqual(agentEnv(env), { PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "k" });
    assert.throws(() => agentEnv({ RADR_AGENT_ENV: "BAD-NAME" }), UsageError);
  });
});

describe("LLM policy in scope (AC1)", () => {
  it("is part of the scope fingerprint: changing it re-closes Gate 1", () => {
    const yml = (p: string) => `version: 1\nclient: acme\nslug: t\nengagement_type: security\ntier: standard\nsource: { origin: /x, sha: ${"a".repeat(40)} }\npaths: { include: ["**"], exclude: [] }\nstacks: []\nlanes: [lint]\nrubric: v1\nnetwork: { mode: offline, enforcement: declared }\nllm_policy: ${p}\nclient_licenses: []\n`;
    const hashes = ["off", "metadata-only", "code-allowed"].map((p) => engagementHash(parseEngagement(yml(p), "e.yml")));
    assert.equal(new Set(hashes).size, 3);
  });
});

describe("invokeAgent (the LLM gate)", () => {
  it("refuses under policy off, and when RADR_AGENT_CMD is unset, before spawning anything", async () => {
    const off = setup(['{"answer":"x"}'], [], "off");
    await assert.rejects(invokeAgent(off.ctx, { purpose: "triage", prompt: "p", validate }), /policy is "off"/);
    assert.equal(off.calls(), 0);
    const unset = setup(['{"answer":"x"}']);
    await assert.rejects(invokeAgent({ ...unset.ctx, env: {} }, { purpose: "triage", prompt: "p", validate }), /RADR_AGENT_CMD is not set/);
    assert.equal(unset.calls(), 0);
    assert.equal(off.log.read().length + unset.log.read().length, 0);
  });

  it("sends the prompt on stdin and persists prompt + response with matching event hashes (AC4)", async () => {
    const t = setup(['{"answer":"42"}']);
    const r = await invokeAgent(t.ctx, { purpose: "triage-explain", prompt: "explain F-0001", validate });
    assert.deepEqual(r, { status: "ok", output: { answer: "42" }, callIds: ["L-0001"] });
    assert.equal(readFileSync(path.join(t.script, "stdin-1"), "utf8"), "explain F-0001");
    const [e] = t.log.read();
    assert.equal(e?.type, "llm-call");
    assert.equal(e.data["prompt_hash"], hashBytes(readFileSync(path.join(t.llmDir, "L-0001.prompt.txt"))));
    assert.equal(e.data["response_hash"], hashBytes(readFileSync(path.join(t.llmDir, "L-0001.response.txt"))));
    assert.equal(e.data["argv_hash"], hash(parseAgentCmd(t.ctx.env)));
    assert.equal(e.data["outcome"], "success");
    assert.equal(e.data["policy"], "metadata-only");
  });

  it("gives the agent no ambient access: an empty temp cwd and an allowlisted env", async () => {
    const t = setup(['{"answer":"ok"}'], [], "code-allowed", { RADR_AGENT_ENV: "ANTHROPIC_API_KEY", ANTHROPIC_API_KEY: "k" });
    await invokeAgent(t.ctx, { purpose: "triage", prompt: "p", validate });
    const seen = JSON.parse(readFileSync(path.join(t.script, "seen-1"), "utf8")) as { cwd: string; cwd_entries: number; env_keys: string[] };
    assert.equal(seen.cwd_entries, 0);
    assert.ok(!seen.cwd.startsWith(path.dirname(t.llmDir)), "the agent must not run inside the engagement");
    assert.ok(!seen.env_keys.includes("SECRET_TOKEN"));
    assert.ok(!seen.env_keys.includes("RADR_AGENT_CMD"));
    assert.ok(seen.env_keys.includes("ANTHROPIC_API_KEY"));
  });

  it("schema-invalid output is fail-protocol: retried per the matrix, then partial (AC5)", async () => {
    const t = setup(["not json", '{"answer": 7}']);
    const r = await invokeAgent(t.ctx, { purpose: "triage", prompt: "p", validate });
    assert.equal(r.status, "partial");
    assert.deepEqual(r.callIds, ["L-0001", "L-0002"]);
    assert.deepEqual(t.log.read().map((e) => [e.data["outcome"], e.data["action"]]), [["fail-protocol", "retry"], ["fail-protocol", "partial"]]);
    assert.match(String(t.log.read()[1]?.data["detail"]), /answer/);
  });

  it("a retry that succeeds returns the valid response", async () => {
    const t = setup(['{"wrong": true}', '{"answer":"second"}']);
    const r = await invokeAgent(t.ctx, { purpose: "triage", prompt: "p", validate });
    assert.equal(r.status, "ok");
    assert.equal(r.output.answer, "second");
    assert.equal(t.calls(), 2);
  });

  it("a failing agent is tool-error (retried); a missing agent aborts", async () => {
    const failing = setup(["", ""], [3, 3]);
    const r = await invokeAgent(failing.ctx, { purpose: "triage", prompt: "p", validate });
    assert.deepEqual([r.status, r.status === "ok" ? "" : r.outcome], ["partial", "tool-error"]);
    const missing = setup([]);
    const m = await invokeAgent({ ...missing.ctx, env: { ...missing.ctx.env, RADR_AGENT_CMD: "/nonexistent/agent" } }, { purpose: "triage", prompt: "p", validate });
    assert.deepEqual([m.status, m.status === "ok" ? "" : m.outcome], ["abort", "tool-missing"]);
    assert.equal(missing.log.read().length, 1);
  });
});
