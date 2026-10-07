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

const FILES: Record<string, string> = {
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
