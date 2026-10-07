// Deterministic fixture repo (M1 plan T6.1). Fixed identities, dates, branch name, and content
// mean the commit SHAs are identical on every machine and every run.
//
// History:
//   c1 "initial app"      TS + Python sources with lint issues; vulnerable dependency pins
//   c2 "add deploy config" adds config/deploy.env containing a fake AWS access key id
//   c3 "remove secret"     deletes config/deploy.env → the secret exists ONLY in history

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { run } from "../../src/core/exec.js";

// Assembled at runtime so no secret-shaped literal appears in this repository's own source
// (keeps radr's repo clean for its own secret scanning and for push protection).
export const FAKE_AWS_KEY_ID = ["AK", "IA", "Q3EGTZ7LXW5RNKPM"].join("");

const IDENTITY = {
  GIT_AUTHOR_NAME: "Fixture Author",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture Author",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

export const FILES: Readonly<Record<string, string>> = {
  "package.json": `{
  "name": "fixture-app",
  "version": "1.0.0",
  "private": true,
  "dependencies": { "lodash": "4.17.20" }
}
`,
  "package-lock.json": `{
  "name": "fixture-app",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": { "name": "fixture-app", "version": "1.0.0", "dependencies": { "lodash": "4.17.20" } },
    "node_modules/lodash": {
      "version": "4.17.20",
      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",
      "integrity": "sha512-PlhdFcillOINfeV7Ni6oF1TAEayyZBoZ8bcshTHqOYJYlrqzRK5hagpagky5o4HfCzzd1TRkXPMFq6cKk9rGmA=="
    }
  }
}
`,
  "src/server.ts": `import _ from "lodash";

export function handler(input: string) {
  var unused = 1;
  if (input == "admin") {
    return eval(input);
  }
  return _.template(input)();
}
`,
  "app/main.py": `import os, sys
import subprocess


def run(cmd):
    unused = 42
    return subprocess.call(cmd, shell=True)
`,
  "requirements.txt": "requests==2.19.1\n",
  "README.md": "# fixture-app\n\nA deliberately flawed fixture for radr tests.\n",
};

export interface FixtureRepo {
  readonly dir: string;
  readonly commits: readonly string[];
}

async function g(dir: string, args: string[], date: string): Promise<string> {
  const r = await run({
    command: "git",
    args: ["-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args],
    cwd: dir,
    inheritEnv: ["PATH"],
    env: { ...IDENTITY, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  if (r.outcome !== "ok") throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, { mode: 0o644 });
}

export async function makeFixtureRepo(dir: string): Promise<FixtureRepo> {
  mkdirSync(dir, { recursive: true });
  await g(dir, ["init", "-q", "-b", "main"], "2026-01-01T00:00:00Z");
  const commits: string[] = [];

  for (const [rel, content] of Object.entries(FILES)) write(dir, rel, content);
  await g(dir, ["add", "-A"], "2026-01-01T00:00:00Z");
  await g(dir, ["commit", "-q", "-m", "initial app"], "2026-01-01T10:00:00Z");
  commits.push(await g(dir, ["rev-parse", "HEAD"], "2026-01-01T10:00:00Z"));

  write(dir, "config/deploy.env", `AWS_REGION=us-east-1\nAWS_ACCESS_KEY_ID=${FAKE_AWS_KEY_ID}\n`);
  await g(dir, ["add", "-A"], "2026-01-02T00:00:00Z");
  await g(dir, ["commit", "-q", "-m", "add deploy config"], "2026-01-02T10:00:00Z");
  commits.push(await g(dir, ["rev-parse", "HEAD"], "2026-01-02T10:00:00Z"));

  rmSync(path.join(dir, "config"), { recursive: true });
  await g(dir, ["add", "-A"], "2026-01-03T00:00:00Z");
  await g(dir, ["commit", "-q", "-m", "remove secret"], "2026-01-03T10:00:00Z");
  commits.push(await g(dir, ["rev-parse", "HEAD"], "2026-01-03T10:00:00Z"));

  return { dir, commits };
}

/**
 * Sandbox fixture (M2): a buildable TS/JS + Python project with real tests, one dependency per
 * stack (exercising the offline cache), and one deliberate type error per stack.
 */
export const SANDBOX_FILES: Readonly<Record<string, string>> = {
  "package.json": `{
  "name": "sbx-fixture",
  "version": "1.0.0",
  "private": true,
  "scripts": { "test": "node --test" },
  "dependencies": { "is-number": "7.0.0" }
}
`,
  "package-lock.json": `{
  "name": "sbx-fixture",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": { "name": "sbx-fixture", "version": "1.0.0", "dependencies": { "is-number": "7.0.0" } },
    "node_modules/is-number": {
      "version": "7.0.0",
      "resolved": "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz",
      "integrity": "sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==",
      "license": "MIT",
      "engines": { "node": ">=0.12.0" }
    }
  }
}
`,
  "tsconfig.json": `{ "compilerOptions": { "strict": true, "noEmit": true, "target": "ES2022", "module": "commonjs" }, "include": ["src/**/*.ts"] }
`,
  "src/math.ts": `export const answer: number = "forty-two";
`,
  "index.js": `const isNumber = require("is-number");
exports.add = (a, b) => {
  if (!isNumber(a) || !isNumber(b)) throw new Error("not a number");
  return a + b;
};
exports.unused = () => 42;
`,
  "test/add.test.js": `const test = require("node:test");
const assert = require("node:assert");
const { add } = require("../index.js");
test("adds", () => assert.equal(add(1, 2), 3));
`,
  "requirements.txt": "six==1.17.0\n",
  "app/__init__.py": "",
  "app/calc.py": `def add(a: int, b: int) -> int:
    return a + b


def broken() -> int:
    return "not an int"
`,
  "tests/test_calc.py": `from app.calc import add


def test_add():
    assert add(2, 3) == 5
`,
};

export async function makeSandboxFixtureRepo(dir: string): Promise<FixtureRepo> {
  mkdirSync(dir, { recursive: true });
  await g(dir, ["init", "-q", "-b", "main"], "2026-02-01T00:00:00Z");
  for (const [rel, content] of Object.entries(SANDBOX_FILES)) write(dir, rel, content);
  await g(dir, ["add", "-A"], "2026-02-01T00:00:00Z");
  await g(dir, ["commit", "-q", "-m", "buildable fixture"], "2026-02-01T10:00:00Z");
  return { dir, commits: [await g(dir, ["rev-parse", "HEAD"], "2026-02-01T10:00:00Z")] };
}

/** A deeply branching Python function: cyclomatic complexity 1 + 2 per `if … or …` → well above 30. */
const TANGLED = ["def tangled(a, b):", "    r = 0", ...Array.from({ length: 20 }, (_, i) => `    if a == ${String(i)} or b == ${String(i)}:\n        r += ${String(i)}`), "    return r", ""].join("\n");
const CALC = `export function calc(x, y, z) {
  let total = 0;
  for (let i = 0; i < x; i++) {
    if (i % 2 === 0) { total += y * i; } else { total -= z; }
    if (total > 1000) { total = total / 2; }
    if (total < -1000) { total = total * -1; }
  }
  return total + x + y + z;
}
`;

/** Health fixture (M3 W2): IaC, a GPL source file, an AGPL dependency, complex and duplicated code. */
export const HEALTH_FILES: Readonly<Record<string, string>> = {
  "Dockerfile": "FROM ubuntu:latest\nRUN apt-get update && apt-get install -y curl\nUSER root\nCMD [\"sh\"]\n",
  "infra/main.tf": 'resource "aws_s3_bucket" "b" {\n  bucket = "data"\n  acl    = "public-read"\n}\n',
  "vendor/lib.c": "/* SPDX-License-Identifier: GPL-3.0-only */\nint x;\n",
  "src/a.js": CALC,
  "src/b.js": CALC,
  "src/tangled.py": TANGLED,
  "package.json": '{\n  "name": "health-app",\n  "version": "1.0.0",\n  "private": true,\n  "license": "UNLICENSED",\n  "dependencies": { "netcopy": "1.0.0" }\n}\n',
  "package-lock.json": `{
  "name": "health-app",
  "version": "1.0.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": { "name": "health-app", "version": "1.0.0", "license": "UNLICENSED", "dependencies": { "netcopy": "1.0.0" } },
    "node_modules/netcopy": { "version": "1.0.0", "license": "AGPL-3.0-only" }
  }
}
`,
};

export async function makeHealthFixtureRepo(dir: string): Promise<FixtureRepo> {
  mkdirSync(dir, { recursive: true });
  await g(dir, ["init", "-q", "-b", "main"], "2026-01-01T00:00:00Z");
  for (const [rel, content] of Object.entries(HEALTH_FILES)) write(dir, rel, content);
  await g(dir, ["add", "-A"], "2026-01-01T00:00:00Z");
  await g(dir, ["commit", "-q", "-m", "health fixture"], "2026-01-01T10:00:00Z");
  return { dir, commits: [await g(dir, ["rev-parse", "HEAD"], "2026-01-01T10:00:00Z")] };
}
