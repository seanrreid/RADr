// The curated rule pack (PRD §14.2): content hashes for the scope fingerprint, and the
// support-bar report against rules/targets.yml (M3 AC6).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { assetPath, readAsset } from "../core/assets.js";
import { compareCodePoints, stableSort } from "../core/determinism.js";
import { InternalError } from "../core/errors.js";
import { parseDocument } from "yaml";
import { parseYaml } from "../core/yaml.js";
import { treeHash } from "../sandbox/deps.js";

/** Hashes of each pack directory: part of toolchain.lock, so any rule change re-opens Gate 1. */
export function rulePackHashes(): Record<string, string> {
  return {
    rules_pack: treeHash(assetPath("rules/pack")).hash,
    rules_lgpl: treeHash(assetPath("rules/lgpl")).hash,
    rules_authored: treeHash(assetPath("rules/authored")).hash,
  };
}

/** Rule languages → radr stacks (rules/targets.yml keys). */
const LANG_TO_STACK: Readonly<Record<string, string>> = {
  javascript: "typescript-javascript", typescript: "typescript-javascript", js: "typescript-javascript", ts: "typescript-javascript",
  python: "python", go: "go", rust: "rust", java: "java-kotlin", kotlin: "java-kotlin", php: "php", ruby: "ruby", csharp: "csharp", "c#": "csharp",
};

export interface PackRule {
  readonly id: string;
  readonly pack: PackName;
  readonly file: string;
  readonly stacks: readonly string[];
  readonly cwes: readonly number[];
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort(compareCodePoints).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.ya?ml$/.test(n) ? [p] : [];
  });
}

export type PackName = "authored" | "pack" | "lgpl";
export const ALL_PACKS: readonly PackName[] = ["authored", "pack", "lgpl"];

export function packRules(packs: readonly PackName[] = ALL_PACKS): PackRule[] {
  const out: PackRule[] = [];
  for (const pack of packs) {
    const root = assetPath(`rules/${pack}`);
    for (const file of walk(root)) {
      // Third-party rule files may use YAML aliases; read them leniently but bounded (radr's OWN
      // policy files stay alias-free via parseYaml).
      const doc = parseDocument(readFileSync(file, "utf8")).toJS({ maxAliasCount: 1000 }) as { rules?: { id: string; languages?: string[]; metadata?: { cwe?: unknown } }[] };
      for (const r of doc.rules ?? []) {
        const cweField = r.metadata?.cwe;
        const cweText = Array.isArray(cweField) ? cweField.map(String).join(" ") : typeof cweField === "string" ? cweField : "";
        const cwes = [...cweText.matchAll(/CWE-(\d+)/g)].map((m) => Number.parseInt(m[1] ?? "0", 10));
        const stacks = [...new Set((r.languages ?? []).map((lang) => LANG_TO_STACK[lang.toLowerCase()]).filter((s): s is string => s !== undefined))];
        out.push({ id: r.id, pack, file: path.relative(assetPath("rules"), file).split(path.sep).join("/"), stacks: stableSort(stacks, (s) => s), cwes: [...new Set(cwes)].sort((a, b) => a - b) });
      }
    }
  }
  return stableSort(out, (r) => [r.file, r.id]);
}

interface TargetsDoc {
  readonly stacks: Readonly<Record<string, { readonly targets: readonly { readonly cwe: number; readonly group?: readonly number[]; readonly focus: string }[] }>>;
}

export interface StackCoverage {
  readonly stack: string;
  readonly supported: boolean;
  readonly covered: readonly { readonly cwe: number; readonly rules: number }[];
  readonly missing: readonly number[];
  readonly rules: number;
}

/** Support bar (PRD §14.2): a stack is "supported" when every top-10 CWE target has ≥1 rule. */
export function ruleCoverage(packs: readonly PackName[] = ALL_PACKS): StackCoverage[] {
  const targets = parseYaml(readAsset("rules/targets.yml"), "rules/targets.yml") as TargetsDoc;
  if (typeof targets.stacks !== "object") throw new InternalError("rules/targets.yml has no stacks");
  const rules = packRules(packs);
  return stableSort(Object.keys(targets.stacks), (s) => s).map((stack) => {
    const stackRules = rules.filter((r) => r.stacks.includes(stack));
    const covered: { cwe: number; rules: number }[] = [];
    const missing: number[] = [];
    for (const t of targets.stacks[stack]?.targets ?? []) {
      const accept = new Set([t.cwe, ...(t.group ?? [])]);
      const n = stackRules.filter((r) => r.cwes.some((c) => accept.has(c))).length;
      if (n > 0) covered.push({ cwe: t.cwe, rules: n });
      else missing.push(t.cwe);
    }
    return { stack, supported: missing.length === 0, covered, missing, rules: stackRules.length };
  });
}
