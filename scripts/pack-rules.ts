// Maintainer script (M3 W1): assemble the curated Opengrep rule pack (PRD §14.2, Appendix B).
//
//   npm run build && node dist/scripts/pack-rules.js
//
// - Fetches each vetted source at a PINNED commit (never a branch).
// - Classifies EVERY rule file by its own license (GitLab's root LICENSE says MIT, but rule
//   files carry their own headers: MIT, Apache-2.0, LGPL-3.0, Commons Clause, GPL, proprietary).
// - Permissive rules → rules/pack/<source>/…; LGPL-3.0 → rules/lgpl/<source>/… (unmodified,
//   pending counsel, PRD §20 #10); everything else is excluded.
// - A rule is only accepted WITH its test fixture (same basename, non-YAML extension).
// - Files are copied byte-for-byte; rules/PROVENANCE.lock records path, source, commit,
//   license, and upstream sha256 for every file (scripts/check-rules.ts verifies it).

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, compareCodePoints, hashBytes } from "../src/core/determinism.js";
import { run } from "../src/core/exec.js";

type Bucket = "pack" | "lgpl" | "excluded";

interface Source {
  readonly id: string;
  readonly url: string;
  readonly commit: string;
  /** Directories (relative to the repo root) to scan for rules. */
  readonly dirs: readonly string[];
  /** How to license-classify a file. */
  readonly classify: (text: string, rel: string) => { bucket: Bucket; license: string };
}

function gitlabClassify(text: string): { bucket: Bucket; license: string } {
  // Some upstream headers repeat the prefix ("# License: License: MIT …"); tolerate it.
  const header = (/^# License: (.+)$/m.exec(text.split("\n").slice(0, 6).join("\n"))?.[1] ?? "").replace(/^(License:\s*)+/, "").trim();
  if (/^MIT\b/.test(header)) return { bucket: "pack", license: "MIT" };
  if (/^Apache/i.test(header)) return { bucket: "pack", license: "Apache-2.0" };
  if (/^GNU Lesser General Public License v3\.0$/.test(header)) return { bucket: "lgpl", license: "LGPL-3.0" };
  return { bucket: "excluded", license: header === "" ? "unknown" : header };
}

export const SOURCES: readonly Source[] = [
  {
    id: "gitlab", url: "https://gitlab.com/gitlab-org/security-products/sast-rules.git", commit: "53bf5cf6df3c51b6c02110f5a638b5e6213666cd", // v2.10.1
    dirs: ["python", "javascript", "go", "java", "csharp", "rules/lgpl/javascript", "rules/lgpl/kotlin"],
    classify: (text) => gitlabClassify(text),
  },
  {
    id: "elttam", url: "https://github.com/elttam/semgrep-rules.git", commit: "244268562cc92d33f54b8a60a187df5520f91b26",
    dirs: ["rules"],
    classify: () => ({ bucket: "pack", license: "MIT" }), // repo LICENSE: MIT; files carry no headers
  },
];

const RULE = /\.ya?ml$/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort(compareCodePoints)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

async function fetchSource(s: Source, into: string): Promise<void> {
  const git = (args: string[]) => run({ command: "git", args, cwd: into, inheritEnv: ["PATH", "HOME"], timeoutMs: 10 * 60 * 1000 });
  mkdirSync(into, { recursive: true });
  for (const args of [["init", "-q"], ["remote", "add", "origin", s.url], ["fetch", "-q", "--depth", "1", "origin", s.commit], ["checkout", "-q", "FETCH_HEAD"]]) {
    const r = await git(args);
    if (r.outcome !== "ok") throw new Error(`${s.id}: git ${args[0] ?? ""} failed: ${r.stderr.toString()}`);
  }
}

interface TestReport {
  results?: Record<string, { checks: Record<string, { passed: boolean; matches: Record<string, { expected_lines: number[] }> }> }>;
  config_with_errors?: unknown[];
}

/**
 * `opengrep test` one rule against its fixtures: pass | invalid | failing | untested.
 * `explain`, when given, receives why a rule is invalid (exec outcome, exit code, stderr tail).
 */
export async function testRule(opengrep: string, rule: string, fixtures: readonly string[], explain?: (why: string) => void): Promise<"pass" | "invalid" | "failing" | "untested"> {
  const r = await run({ command: opengrep, args: ["test", "--json", "--config", rule, ...fixtures], cwd: path.dirname(rule), env: { HOME: tmpdir() }, timeoutMs: 120_000, okExitCodes: [0, 1, 2, 7] });
  const why = (what: string): "invalid" => {
    explain?.(`${what}; outcome=${r.outcome} exit=${String(r.exitCode)} signal=${String(r.signal)}; stderr: ${r.stderr.toString().trim().slice(-600)}`);
    return "invalid";
  };
  let rep: TestReport;
  try {
    rep = JSON.parse(r.stdout.toString()) as TestReport;
  } catch {
    return why("stdout is not JSON");
  }
  if ((rep.config_with_errors ?? []).length > 0 || r.exitCode === 7) return why("config errors");
  const checks = Object.values(rep.results ?? {}).flatMap((x) => Object.values(x.checks));
  if (checks.length === 0) return "untested";
  if (checks.some((c) => !c.passed)) return "failing";
  if (checks.some((c) => Object.values(c.matches).every((m) => m.expected_lines.length === 0))) return "untested";
  return "pass";
}

async function main(): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const opengrep = process.env["OPENGREP"];
  if (opengrep === undefined) throw new Error("set OPENGREP to the pinned opengrep binary (radr tools install --tool opengrep)");
  const work = mkdtempSync(path.join(tmpdir(), "pack-rules-"));
  for (const bucket of ["pack", "lgpl"]) rmSync(path.join(root, "rules", bucket), { recursive: true, force: true });
  const lock: Record<string, unknown>[] = [];
  const counts: Record<string, number> = {};
  const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };

  for (const s of SOURCES) {
    const repo = path.join(work, s.id);
    await fetchSource(s, repo);
    for (const dir of s.dirs) {
      const base = path.join(repo, dir);
      if (!existsSync(base)) throw new Error(`${s.id}: ${dir} missing at ${s.commit}`);
      for (const file of walk(base).filter((f) => RULE.test(f))) {
        const text = readFileSync(file, "utf8");
        if (!/^rules:/m.test(text)) continue;
        const stem = file.replace(RULE, "");
        const fixtures = readdirSync(path.dirname(file)).map((n) => path.join(path.dirname(file), n))
          .filter((f) => f !== file && !RULE.test(f) && path.basename(f).startsWith(`${path.basename(stem)}.`));
        const rel = path.relative(repo, file);
        const { bucket, license } = s.classify(text, rel);
        if (bucket === "excluded") { bump(`${s.id}:excluded(${license})`); continue; }
        if (fixtures.length === 0) { bump(`${s.id}:no-fixture`); continue; }
        // Gate: the rule must pass its own fixtures, with at least one expected match per check.
        const verdict = await testRule(opengrep, file, fixtures);
        if (verdict !== "pass") { bump(`${s.id}:rejected(${verdict})`); continue; }
        for (const f of [file, ...fixtures]) {
          const fr = path.relative(repo, f);
          const dest = path.join(root, "rules", bucket, s.id, fr);
          mkdirSync(path.dirname(dest), { recursive: true });
          copyFileSync(f, dest);
          lock.push({ path: path.relative(root, dest).split(path.sep).join("/"), source: s.id, url: s.url, commit: s.commit, upstream: fr, license, sha256: hashBytes(readFileSync(f)), role: f === file ? "rule" : "fixture" });
        }
        bump(`${s.id}:${bucket}`);
      }
    }
  }
  lock.sort((a, b) => compareCodePoints(String(a["path"]), String(b["path"])));
  writeFileSync(path.join(root, "rules", "PROVENANCE.lock"), `${lock.map((e) => canonicalJson(e)).join("\n")}\n`);
  rmSync(work, { recursive: true, force: true });
  for (const k of Object.keys(counts).sort(compareCodePoints)) process.stdout.write(`${k.padEnd(48)} ${String(counts[k])}\n`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
