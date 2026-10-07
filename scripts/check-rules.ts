// CI check for the rule pack (M3 AC5, PRD §14.2 + Appendix B "Pack hygiene").
//
//   node dist/scripts/check-rules.js            # provenance, licenses, unmodified, fixtures present
//   OPENGREP=… node dist/scripts/check-rules.js # + every rule passes its fixtures
//
// Fails when:
//   - a file under rules/pack or rules/lgpl is missing from rules/PROVENANCE.lock (or vice versa)
//   - a file's sha256 differs from its recorded upstream hash (rules are never edited in place)
//   - rules/pack holds anything but MIT / Apache-2.0, or rules/lgpl anything but LGPL-3.0
//   - a rule file's own header mentions Commons Clause, GPL/AGPL, or "proprietary" (in pack/)
//   - a rule has no fixture, or (with OPENGREP) fails or doesn't exercise its fixtures

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareCodePoints, hashBytes } from "../src/core/determinism.js";
import { testRule } from "./pack-rules.js";

interface Entry { path: string; license: string; sha256: string; role: "rule" | "fixture" }

const ALLOWED: Readonly<Record<string, readonly string[]>> = { pack: ["MIT", "Apache-2.0"], lgpl: ["LGPL-3.0"] };
const CONCURRENCY = 8;
const FORBIDDEN_IN_PACK = /Commons Clause|\bA?GPL\b|General Public License(?! v3\.0 .*Lesser)|proprietary/i;

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort(compareCodePoints).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

export function checkRules(root: string): { errors: string[]; rules: Entry[] } {
  const errors: string[] = [];
  const lockFile = path.join(root, "rules", "PROVENANCE.lock");
  if (!existsSync(lockFile)) return { errors: ["rules/PROVENANCE.lock missing (run scripts/pack-rules.ts)"], rules: [] };
  const entries = readFileSync(lockFile, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Entry);
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const onDisk = ["pack", "lgpl"].flatMap((b) => walk(path.join(root, "rules", b))).map((p) => path.relative(root, p).split(path.sep).join("/"));

  for (const p of onDisk) {
    const e = byPath.get(p);
    if (e === undefined) { errors.push(`${p}: not in PROVENANCE.lock`); continue; }
    const bytes = readFileSync(path.join(root, p));
    if (hashBytes(bytes) !== e.sha256) errors.push(`${p}: modified (hash differs from upstream); rules are never edited in place`);
    const bucket = p.split("/")[1] ?? "";
    if (!(ALLOWED[bucket] ?? []).includes(e.license)) errors.push(`${p}: license ${e.license} not allowed in rules/${bucket}`);
    if (bucket === "pack" && e.role === "rule" && FORBIDDEN_IN_PACK.test(bytes.toString("utf8").split("\n").slice(0, 8).join("\n"))) {
      errors.push(`${p}: header names a copyleft/non-redistributable license`);
    }
  }
  const present = new Set(onDisk);
  for (const e of entries) if (!present.has(e.path)) errors.push(`${e.path}: listed in PROVENANCE.lock but missing`);
  const rules = entries.filter((e) => e.role === "rule");
  for (const r of rules) {
    const stem = r.path.replace(/\.ya?ml$/, "");
    if (!entries.some((e) => e.role === "fixture" && e.path.startsWith(`${stem}.`))) errors.push(`${r.path}: no fixture`);
  }
  // radr's own rules (rules/authored): not vendored, so no provenance hash, but the same bar:
  // an origin header, and a fixture.
  for (const p of walk(path.join(root, "rules", "authored")).filter((f) => /\.ya?ml$/.test(f))) {
    const rel = path.relative(root, p).split(path.sep).join("/");
    if (!/^# License: radr original/m.test(readFileSync(p, "utf8"))) errors.push(`${rel}: authored rule lacks the "# License: radr original" header`);
    const stem = p.replace(/\.ya?ml$/, "");
    const fixture = readdirSync(path.dirname(p)).some((n) => path.join(path.dirname(p), n).startsWith(`${stem}.`) && !/\.ya?ml$/.test(n));
    if (!fixture) errors.push(`${rel}: no fixture`);
    rules.push({ path: rel, license: "radr", sha256: "", role: "rule" });
  }
  return { errors, rules };
}

async function main(): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const { errors, rules } = checkRules(root);
  const opengrep = process.env["OPENGREP"];
  if (opengrep !== undefined && errors.length === 0) {
    // Rule tests are independent: run them CONCURRENCY at a time; report in rule order.
    const verdicts = new Array<string>(rules.length);
    const reasons = new Array<string>(rules.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let i = next++; i < rules.length; i = next++) {
        const r = rules[i];
        if (r === undefined) continue;
        const abs = path.join(root, r.path);
        const stem = abs.replace(/\.ya?ml$/, "");
        const fixtures = readdirSync(path.dirname(abs)).map((n) => path.join(path.dirname(abs), n)).filter((f) => f !== abs && f.startsWith(`${stem}.`) && !/\.ya?ml$/.test(f));
        verdicts[i] = await testRule(opengrep, abs, fixtures, (why) => { reasons[i] = why; });
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    rules.forEach((r, i) => { if (verdicts[i] !== "pass") errors.push(`${r.path}: fixtures ${verdicts[i] ?? "not run"}${reasons[i] === undefined ? "" : ` (${reasons[i]})`}`); });
  }
  for (const e of errors) process.stderr.write(`check-rules: ${e}\n`);
  if (errors.length > 0) process.exit(1);
  process.stdout.write(`check-rules: ok (${String(rules.length)} rules${opengrep === undefined ? "; fixtures not executed (set OPENGREP)" : ", all fixtures pass"})\n`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
