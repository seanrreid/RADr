// Deterministic fixture repo (M1 plan T6.1). Fixed identities, dates, branch name, and content
// mean the commit SHAs are identical on every machine and every run.
//
// History:
//   c1 "initial app"      TS + Python sources with lint issues; vulnerable dependency pins
//   c2 "add deploy config" adds config/deploy.env containing a fake AWS access key id
//   c3 "remove secret"     deletes config/deploy.env → the secret exists ONLY in history

import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * Polyglot fixture (M3 W3, AC11): one service per new stack, each with a lockfile pinning a
 * dependency that has a vendored OSV advisory (test/fixtures/osv) and one planted SAST signal.
 */
export const POLYGLOT: Readonly<Record<string, { readonly files: Readonly<Record<string, string>>; readonly advisory: string; readonly rule: string }>> = {
  go: {
    advisory: "GO-2022-1059",
    rule: "radr.go.tls-insecure-skip-verify",
    files: {
      "go-svc/go.mod": "module example.com/svc\n\ngo 1.21\n\nrequire golang.org/x/text v0.3.7\n",
      "go-svc/go.sum": "golang.org/x/text v0.3.7 h1:olpwvP2KacW1ZWvsR7uQhoyTYvKAupfQrRGBFM352Gk=\ngolang.org/x/text v0.3.7/go.mod h1:u+2+/6zg+i71rQMx5EYifcBUoKRB4cnTwCvoMxqmVwQ=\n",
      "go-svc/client.go": "package main\n\nimport \"crypto/tls\"\n\nfunc client() *tls.Config {\n\treturn &tls.Config{InsecureSkipVerify: true}\n}\n",
    },
  },
  rust: {
    advisory: "RUSTSEC-2020-0071",
    rule: "radr.rust.tls-verification-disabled",
    files: {
      "rust-svc/Cargo.toml": "[package]\nname = \"svc\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[dependencies]\ntime = \"=0.1.43\"\n",
      "rust-svc/Cargo.lock": "# This file is automatically @generated by Cargo.\nversion = 3\n\n[[package]]\nname = \"svc\"\nversion = \"0.1.0\"\ndependencies = [\n \"time\",\n]\n\n[[package]]\nname = \"time\"\nversion = \"0.1.43\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\nchecksum = \"ca8a50ef2360fbd1eeb0ecd46795a87a19024eb4b53c5dc916ca1fd95fe62438\"\n",
      "rust-svc/src/main.rs": "fn main() {\n    let _c = reqwest::Client::builder().danger_accept_invalid_certs(true).build();\n}\n",
    },
  },
  "java-kotlin": {
    advisory: "GHSA-jfh8-c2jp-5v3q",
    rule: "java_crypto_rule-WeakMessageDigest",
    files: {
      "jvm-svc/gradle.lockfile": "# This is a Gradle generated file for dependency locking.\norg.apache.logging.log4j:log4j-api:2.14.1=compileClasspath,runtimeClasspath\norg.apache.logging.log4j:log4j-core:2.14.1=compileClasspath,runtimeClasspath\nempty=\n",
      "jvm-svc/build.gradle.kts": "plugins { java }\ndependencies { implementation(\"org.apache.logging.log4j:log4j-core:2.14.1\") }\n",
      "jvm-svc/src/main/java/com/example/Hash.java": "package com.example;\n\nimport java.security.MessageDigest;\n\npublic class Hash {\n    public byte[] digest(byte[] data) throws Exception {\n        MessageDigest md = MessageDigest.getInstance(\"MD5\");\n        return md.digest(data);\n    }\n}\n",
    },
  },
  php: {
    advisory: "GHSA-q7rv-6hp3-vh96",
    rule: "radr.php.command-injection",
    files: {
      "php-svc/composer.json": "{\n    \"require\": { \"guzzlehttp/psr7\": \"1.8.2\" }\n}\n",
      "php-svc/composer.lock": "{\n    \"content-hash\": \"0123456789abcdef0123456789abcdef\",\n    \"packages\": [\n        { \"name\": \"guzzlehttp/psr7\", \"version\": \"1.8.2\", \"type\": \"library\" }\n    ],\n    \"packages-dev\": []\n}\n",
      "php-svc/ping.php": "<?php\n$host = $_GET['host'];\nsystem(\"ping -c 1 \" . $host);\n",
    },
  },
  ruby: {
    advisory: "GHSA-3h57-hmj3-gj3p",
    rule: "radr.ruby.command-injection",
    files: {
      "ruby-svc/Gemfile": "source 'https://rubygems.org'\ngem 'rack', '2.2.3'\n",
      "ruby-svc/Gemfile.lock": "GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (2.2.3)\n\nPLATFORMS\n  ruby\n\nDEPENDENCIES\n  rack (= 2.2.3)\n\nBUNDLED WITH\n   2.4.10\n",
      "ruby-svc/app/controllers/tools_controller.rb": "class ToolsController < ApplicationController\n  def ping\n    system(\"ping -c 1 #{params[:host]}\")\n  end\nend\n",
    },
  },
  csharp: {
    advisory: "GHSA-5crp-9r3c-p9vr",
    rule: "radr.csharp.ssrf",
    files: {
      "net-svc/Svc.csproj": "<Project Sdk=\"Microsoft.NET.Sdk.Web\">\n  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>\n  <ItemGroup><PackageReference Include=\"Newtonsoft.Json\" Version=\"12.0.3\" /></ItemGroup>\n</Project>\n",
      "net-svc/packages.lock.json": "{\n  \"version\": 1,\n  \"dependencies\": {\n    \"net8.0\": {\n      \"Newtonsoft.Json\": { \"type\": \"Direct\", \"requested\": \"[12.0.3, )\", \"resolved\": \"12.0.3\", \"contentHash\": \"6mgjfnRB4jKMlzHSl+VD+oUc1IebOZabkbyWj2RiTgWwYPPuaK1H97G1sHqGwPlS5npiF5Q0OrxN1wni2n5QWg==\" }\n    }\n  }\n}\n",
      "net-svc/FetchController.cs": "using System.Net.Http;\nusing Microsoft.AspNetCore.Mvc;\n\npublic class FetchController : Controller\n{\n    private readonly HttpClient client = new HttpClient();\n\n    public async System.Threading.Tasks.Task<string> Fetch()\n    {\n        string url = Request.Query[\"url\"];\n        return await client.GetStringAsync(url);\n    }\n}\n",
    },
  },
};

export async function makePolyglotFixtureRepo(dir: string): Promise<FixtureRepo> {
  mkdirSync(dir, { recursive: true });
  await g(dir, ["init", "-q", "-b", "main"], "2026-01-01T00:00:00Z");
  for (const s of Object.values(POLYGLOT)) for (const [rel, content] of Object.entries(s.files)) write(dir, rel, content);
  await g(dir, ["add", "-A"], "2026-01-01T00:00:00Z");
  await g(dir, ["commit", "-q", "-m", "polyglot fixture"], "2026-01-01T10:00:00Z");
  return { dir, commits: [await g(dir, ["rev-parse", "HEAD"], "2026-01-01T10:00:00Z")] };
}

/**
 * Stack sandbox fixture (M3 W5, AC12): one small buildable project per W5 stack, each with a
 * dependency (exercising the offline cache) and planted lint/type signals. Files live in
 * test/fixtures/stack-sandbox (lockfiles generated in the pinned stack images).
 */
export async function makeStackSandboxRepo(dir: string): Promise<FixtureRepo> {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../test/fixtures/stack-sandbox");
  mkdirSync(dir, { recursive: true });
  cpSync(src, dir, { recursive: true });
  await g(dir, ["init", "-q", "-b", "main"], "2026-01-01T00:00:00Z");
  await g(dir, ["add", "-A"], "2026-01-01T00:00:00Z");
  await g(dir, ["commit", "-q", "-m", "stack sandbox fixture"], "2026-01-01T10:00:00Z");
  return { dir, commits: [await g(dir, ["rev-parse", "HEAD"], "2026-01-01T10:00:00Z")] };
}

/**
 * Debug fixture (M5): a dependency-free Node project with 20 commits. Commit 13 (index 12)
 * plants a regression in add(); every other commit only touches CHANGELOG.md. Fixed dates
 * and identities make the SHAs identical everywhere, so bisect results can be asserted.
 */
export const REGRESSION_COMMITS = 20;
export const REGRESSION_BAD_INDEX = 12;
/** The repro: exit 0 when add(2, 2) is 4 (bug absent), 1 when it isn't (bug present). */
export const REGRESSION_REPRO = `#!/bin/sh\nnode -e "process.exit(require('./src/math.js').add(2, 2) === 4 ? 0 : 1)"\n`;

export async function makeRegressionRepo(dir: string): Promise<FixtureRepo> {
  mkdirSync(dir, { recursive: true });
  await g(dir, ["init", "-q", "-b", "main"], "2026-02-01T00:00:00Z");
  write(dir, "package.json", `{\n  "name": "calc",\n  "version": "1.0.0",\n  "private": true,\n  "scripts": { "test": "node --test" }\n}\n`);
  write(dir, "package-lock.json", `{\n  "name": "calc",\n  "version": "1.0.0",\n  "lockfileVersion": 3,\n  "requires": true,\n  "packages": {\n    "": { "name": "calc", "version": "1.0.0" }\n  }\n}\n`);
  write(dir, "test/math.test.js", `const { test } = require("node:test");\nconst assert = require("node:assert");\nconst { mul } = require("../src/math.js");\ntest("mul", () => assert.equal(mul(2, 3), 6));\n`);
  const commits: string[] = [];
  for (let i = 0; i < REGRESSION_COMMITS; i++) {
    const add = i >= REGRESSION_BAD_INDEX ? "(a, b) => a + b + (a === b ? 1 : 0)" : "(a, b) => a + b";
    write(dir, "src/math.js", `const add = ${add};\nconst mul = (a, b) => a * b;\nmodule.exports = { add, mul };\n`);
    write(dir, "CHANGELOG.md", Array.from({ length: i + 1 }, (_, k) => `- change ${String(k + 1)}`).join("\n") + "\n");
    const day = String(i + 1).padStart(2, "0");
    await g(dir, ["add", "-A"], `2026-02-${day}T00:00:00Z`);
    await g(dir, ["commit", "-q", "-m", i === REGRESSION_BAD_INDEX ? "speed up add" : `change ${String(i + 1)}`], `2026-02-${day}T10:00:00Z`);
    commits.push(await g(dir, ["rev-parse", "HEAD"], `2026-02-${day}T10:00:00Z`));
  }
  return { dir, commits };
}

/**
 * Verify fixture (M6): three Python files whose `import unused…` line is a lint finding each.
 *   c1 "initial"       a, b, c all have the unused import          → 3 findings
 *   c2 "fix a and c"   a and c fixed, b kept                        → 1 finding
 *   c3 "regress c"     c's unused import comes back                 → 2 findings
 *   c4 "break lint"    like c2, plus app/BREAK (VERIFY_RUFF fails)  → lint partial
 */
export async function makeVerifyRepo(dir: string): Promise<FixtureRepo> {
  mkdirSync(dir, { recursive: true });
  await g(dir, ["init", "-q", "-b", "main"], "2026-03-01T00:00:00Z");
  const file = (name: string, bad: boolean) => { write(dir, `app/${name}.py`, `${bad ? `import unused_${name}\n` : ""}def ${name}():\n    return 1\n`); };
  const commits: string[] = [];
  const commit = async (msg: string, day: string) => {
    await g(dir, ["add", "-A"], `2026-03-${day}T00:00:00Z`);
    await g(dir, ["commit", "-q", "-m", msg], `2026-03-${day}T10:00:00Z`);
    commits.push(await g(dir, ["rev-parse", "HEAD"], `2026-03-${day}T10:00:00Z`));
  };
  file("a", true); file("b", true); file("c", true);
  await commit("initial", "01");
  file("a", false); file("c", false);
  await commit("fix a and c", "02");
  file("c", true);
  await commit("regress c", "03");
  file("c", false);
  write(dir, "app/BREAK", "\n");
  await commit("break lint", "04");
  return { dir, commits };
}

/** Fake ruff for makeVerifyRepo: F401 per `import unused…` file; exit 3 when app/BREAK exists. */
export const VERIFY_RUFF = `P=$(pwd -P); [ -f app/BREAK ] && exit 3; out=""; for f in app/*.py; do if head -n1 "$f" | grep -q '^import unused'; then out="$out\${out:+,}{\\"filename\\":\\"$P/$f\\",\\"code\\":\\"F401\\",\\"message\\":\\"unused import\\",\\"location\\":{\\"row\\":1},\\"end_location\\":{\\"row\\":1}}"; fi; done; printf '[%s]' "$out"`;

/**
 * Diff fixture (M6): a base commit with two lint findings (a, b), then a "PR" commit that
 * touches b.py (its finding unchanged, so baselined) and adds d.py with a new finding.
 * Use with VERIFY_RUFF.
 */
export async function makeDiffRepo(dir: string): Promise<FixtureRepo> {
  mkdirSync(dir, { recursive: true });
  await g(dir, ["init", "-q", "-b", "main"], "2026-04-01T00:00:00Z");
  write(dir, "app/a.py", "import unused_a\ndef a():\n    return 1\n");
  write(dir, "app/b.py", "import unused_b\ndef b():\n    return 1\n");
  await g(dir, ["add", "-A"], "2026-04-01T00:00:00Z");
  await g(dir, ["commit", "-q", "-m", "base"], "2026-04-01T10:00:00Z");
  const base = await g(dir, ["rev-parse", "HEAD"], "2026-04-01T10:00:00Z");
  write(dir, "app/b.py", "import unused_b\ndef b():\n    return 2\n");
  write(dir, "app/d.py", "import unused_d\ndef d():\n    return 1\n");
  await g(dir, ["add", "-A"], "2026-04-02T00:00:00Z");
  await g(dir, ["commit", "-q", "-m", "pr: change b, add d"], "2026-04-02T10:00:00Z");
  return { dir, commits: [base, await g(dir, ["rev-parse", "HEAD"], "2026-04-02T10:00:00Z")] };
}
