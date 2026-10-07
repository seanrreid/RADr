import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { InternalError } from "../../src/core/errors.js";
import type { Finding } from "../../src/findings/types.js";
import { batchPrompts, promptFreeText, renderPrompt } from "../../src/llm/prompt.js";
import { CONTEXT_LINES, MAX_SNIPPET_LINES, leakedRuns, promptFinding, quotes } from "../../src/llm/redact.js";
import { tmpDir } from "../helpers/tmp.js";

const SRC = [
  "const express = require('express');",
  "const app = express();",
  "app.get('/user', (req, res) => {",
  "  const query = \"SELECT * FROM users WHERE id = \" + req.query.id;",
  "  db.execute(query);",
  "});",
  ...Array.from({ length: 80 }, (_, i) => `// filler line ${String(i)}`),
].join("\n");

function repo(): string {
  const root = tmpDir();
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src", "app.js"), SRC);
  writeFileSync(path.join(root, ".env"), "AWS_SECRET=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY\n");
  return root;
}

function finding(over: Partial<Finding>): Finding {
  return {
    type: "finding", id: "F-0001", fingerprint: "sha256:" + "0".repeat(64), class: "tool", severity: "high", rubric_version: "v1",
    epss_bp: null, kev: null, snippet_hash: null, lane: "sast", tool: "opengrep", tool_version: "1", rule_id: "js-sqli",
    category: "security", file: "src/app.js", line: 4, end_line: 4, message: "Possible SQL injection.", tool_severity: "ERROR",
    snippet: "  const query = \"SELECT * FROM users WHERE id = \" + req.query.id;", engine_fingerprint: null, cve: null, aliases: [],
    cvss: null, raw_ref: "raw/sast/R-0001.json", tags: [], ...over,
  };
}

describe("quotes (the redaction measure)", () => {
  it("matches a 12-character run, ignoring whitespace differences", () => {
    assert.equal(quotes("found `req.query.id` in a query", SRC), true);
    assert.equal(quotes("found SELECT  *  FROM   users here", SRC), true);
    assert.equal(quotes("Possible SQL injection.", SRC), false);
    assert.equal(quotes("short", SRC), false);
  });
});

describe("promptFinding (PRD §9)", () => {
  it("metadata-only: no snippet, no code, and a message without quoted code passes through", () => {
    const p = promptFinding(finding({}), "metadata-only", repo());
    assert.equal(p.message, "Possible SQL injection.");
    assert.equal(p.code, undefined);
    assert.equal("snippet" in p, false);
  });

  it("metadata-only: a message that interpolates the matched code is replaced by the rule ID", () => {
    const p = promptFinding(finding({ message: "Tainted value req.query.id flows into db.execute(query)" }), "metadata-only", repo());
    assert.equal(p.message, "js-sqli");
  });

  it("file-level findings (line 0) check the message against the whole file", () => {
    const p = promptFinding(finding({ line: 0, end_line: 0, message: "uses require('express') at top level" }), "metadata-only", repo());
    assert.equal(p.message, "js-sqli");
  });

  it("a file radr can't read, or one outside the worktree, sends no message", () => {
    assert.equal(promptFinding(finding({ file: "gone.js" }), "metadata-only", repo()).message, "js-sqli");
    assert.equal(promptFinding(finding({ file: "../outside.js" }), "code-allowed", repo()).code, undefined);
  });

  it("code-allowed: the anchored lines ±5, numbered from code_start, bounded", () => {
    const root = repo();
    const p = promptFinding(finding({ message: "Tainted value req.query.id flows into db.execute(query)" }), "code-allowed", root);
    assert.equal(p.code_start, 1);
    assert.equal(p.code?.split("\n").length, 4 + CONTEXT_LINES);
    assert.match(p.code ?? "", /req\.query\.id/);
    assert.equal(p.message, "Tainted value req.query.id flows into db.execute(query)");
    const wide = promptFinding(finding({ line: 10, end_line: 80 }), "code-allowed", root);
    assert.equal(wide.code?.split("\n").length, MAX_SNIPPET_LINES);
  });

  it("secrets findings carry neither message nor code, under any policy", () => {
    const f = finding({ lane: "secrets", tool: "gitleaks", rule_id: "aws-secret", category: "secrets", file: ".env", line: 1, end_line: 1, message: "AWS secret wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY" });
    for (const policy of ["metadata-only", "code-allowed"] as const) {
      const p = promptFinding(f, policy, repo());
      assert.equal(p.message, "aws-secret");
      assert.equal(p.code, undefined);
    }
  });
});

describe("prompts and the invariant-3 scan", () => {
  it("metadata-only prompts leak nothing; code-allowed prompts are caught by the scan", () => {
    const root = repo();
    const fs = [finding({ message: "Tainted value req.query.id flows into db.execute(query)" }), finding({ id: "F-0002", line: 5, end_line: 5 })];
    const meta = renderPrompt("Explain these findings.", { purpose: "triage-explain", context: {}, findings: fs.map((f) => promptFinding(f, "metadata-only", root)) });
    assert.deepEqual(leakedRuns(promptFreeText(meta), root), []);
    const code = renderPrompt("Explain these findings.", { purpose: "triage-explain", context: {}, findings: fs.map((f) => promptFinding(f, "code-allowed", root)) });
    assert.deepEqual(leakedRuns(promptFreeText(code), root), ["src/app.js"]);
  });

  it("free text excludes metadata (paths, rule IDs) and radr's own instructions", () => {
    const p = renderPrompt("Instructions mention src/app.js freely.", { purpose: "p", context: { note: "free" }, findings: [promptFinding(finding({}), "metadata-only", repo())] });
    assert.equal(promptFreeText(p), "free\nPossible SQL injection.");
  });

  it("batches under the byte cap, in order, and refuses a finding that can't fit alone", () => {
    const root = repo();
    const fs = Array.from({ length: 30 }, (_, i) => promptFinding(finding({ id: `F-${String(i + 1).padStart(4, "0")}` }), "code-allowed", root));
    const batches = batchPrompts("Explain.", "triage-explain", {}, fs, 4000);
    assert.ok(batches.length > 1);
    assert.deepEqual(batches.flatMap((b) => b.ids), fs.map((f) => f.id));
    for (const b of batches) assert.ok(Buffer.byteLength(b.prompt) <= 4000);
    assert.throws(() => batchPrompts("Explain.", "triage-explain", {}, fs, 200), InternalError);
  });
});
