// `radr doctor` and toolchain.lock (T3.3). The lock records exactly which tool binaries,
// node-tools install, and baseline configs a scope was approved with. A run compares the live
// toolchain to the engagement's lock and resolves any difference as `version-drift` (M1 AC10).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { readAsset } from "../core/assets.js";
import { rulePackHashes } from "../rules/pack.js";
import { hashBytes, stableSort } from "../core/determinism.js";
import { RefusedError } from "../core/errors.js";
import { run } from "../core/exec.js";
import { parseYaml } from "../core/yaml.js";
import { ESLINT_BASELINE, nodeToolsDir, pyToolsDir, readReceipt, toolDir } from "./install.js";
import { pyToolVersions } from "./image.js";
import { currentPlatform, loadManifest, type Manifest } from "./manifest.js";

export type ToolState = "ok" | "missing" | "drift";

export interface ToolCheck {
  readonly tool: string;
  readonly state: ToolState;
  readonly version: string;
  readonly binPath?: string;
  readonly binSha256?: string;
  readonly detail: string;
}

export interface ToolchainLock {
  readonly version: 1;
  readonly mode: "host" | "container";
  readonly platform: string;
  readonly tools: Readonly<Record<string, { readonly version: string; readonly bin_sha256: string }>>;
  readonly node_tools: { readonly lock_sha256: string; readonly eslint_version: string };
  readonly configs: Readonly<Record<string, string>>;
  /** Container runtime + pinned image refs (M2). null = no runtime: sandboxed lanes unavailable. */
  readonly sandbox?: { readonly runtime: string; readonly version: string; readonly images: Readonly<Record<string, string>> } | null;
  /** Container mode (M3): the locally built toolchain image every static lane runs in. */
  readonly image?: { readonly tag: string; readonly id: string; readonly context_hash: string } | null;
}

/** Verify one manifest tool: receipt present, binary hash matches receipt, binary reports the pinned version. */
export async function checkTool(home: string, name: string, manifest: Manifest): Promise<ToolCheck> {
  const entry = manifest.tools[name];
  if (entry === undefined) throw new RefusedError(`unknown tool "${name}"`);
  const dir = toolDir(home, name, entry.version);
  const receipt = readReceipt(dir);
  const base = { tool: name, version: entry.version };
  if (receipt === undefined) return { ...base, state: "missing", detail: "not installed (run `radr tools install`)" };
  const binPath = path.join(dir, receipt.bin);
  if (!existsSync(binPath)) return { ...base, state: "missing", detail: `binary missing at ${binPath}` };
  const binSha256 = hashBytes(readFileSync(binPath));
  if (binSha256 !== receipt.bin_sha256) return { ...base, state: "drift", binPath, binSha256, detail: "binary changed since install" };
  if (receipt.archive_sha256 !== entry.platforms[currentPlatform()].sha256) {
    return { ...base, state: "drift", binPath, binSha256, detail: "installed from a different artifact than the manifest pins" };
  }
  const r = await run({ command: binPath, args: [...entry.version_args], cwd: dir, timeoutMs: 30_000 });
  const reported = new RegExp(entry.version_pattern).exec(`${r.stdout.toString()}\n${r.stderr.toString()}`)?.[1];
  if (reported !== entry.version) {
    return { ...base, state: "drift", binPath, binSha256, detail: `reports version ${reported ?? "(unparseable)"}, manifest pins ${entry.version}` };
  }
  return { ...base, state: "ok", binPath, binSha256, detail: "ok" };
}

export function checkNodeTools(home: string): ToolCheck {
  const dir = nodeToolsDir(home);
  const pkg = path.join(dir, "node_modules", "eslint", "package.json");
  const base = { tool: "node-tools", version: "eslint" };
  if (!existsSync(pkg) || !existsSync(path.join(dir, ESLINT_BASELINE))) return { ...base, state: "missing", detail: "not installed (run `radr tools install`)" };
  const eslintVersion = (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version;
  const installedConfig = hashBytes(readFileSync(path.join(dir, ESLINT_BASELINE)));
  if (installedConfig !== hashBytes(readAsset(`toolchain/configs/eslint/${ESLINT_BASELINE}`))) {
    return { ...base, version: eslintVersion, state: "drift", detail: "installed baseline config differs from radr's" };
  }
  return { ...base, version: eslintVersion, state: "ok", binPath: path.join(dir, "node_modules", "eslint", "bin", "eslint.js"), detail: "ok" };
}

/**
 * Host lizard (maint lane): installed with pip --target from the hash lock and run by the host's
 * python3. binPath is that interpreter (resolved now, so a run uses the same one); binSha256 is
 * lizard's own module, so an edited install is drift.
 */
export async function checkPyTools(home: string): Promise<ToolCheck> {
  const version = pyToolVersions()["lizard"] ?? "";
  const site = path.join(pyToolsDir(home), "site");
  const base = { tool: "lizard", version };
  if (!existsSync(path.join(site, "lizard.py"))) return { ...base, state: "missing", detail: "not installed (run `radr tools install`; needs python3 on PATH)" };
  const r = await run({ command: "python3", args: ["-c", "import sys, lizard; print(sys.executable); print(lizard.version)"], cwd: site, inheritEnv: ["PATH"], env: { PYTHONPATH: site }, timeoutMs: 30_000 });
  if (r.outcome !== "ok") return { ...base, state: "missing", detail: `python3 cannot run lizard: ${r.stderr.toString().trim().split("\n").at(-1) ?? r.outcome}` };
  const [python, reported] = r.stdout.toString().trim().split("\n");
  const binSha256 = hashBytes(readFileSync(path.join(site, "lizard.py")));
  if (reported !== version) return { ...base, state: "drift", binPath: python ?? "", binSha256, detail: `reports version ${reported ?? "(none)"}, lock pins ${version}` };
  return { ...base, state: "ok", binPath: python ?? "", binSha256, detail: "ok" };
}

export async function doctor(home: string): Promise<ToolCheck[]> {
  const manifest = loadManifest();
  const checks = await Promise.all(stableSort(Object.keys(manifest.tools), (t) => t).map((t) => checkTool(home, t, manifest)));
  return [...checks, await checkPyTools(home), checkNodeTools(home)];
}

/** Build the lock from a fully healthy toolchain; refuses if anything is missing or drifted. */
export function buildLock(checks: readonly ToolCheck[], sandbox: ToolchainLock["sandbox"] = null): ToolchainLock {
  const bad = checks.filter((c) => c.state !== "ok");
  if (bad.length > 0) throw new RefusedError(`toolchain not ready: ${bad.map((c) => `${c.tool} ${c.state} (${c.detail})`).join("; ")}`);
  const tools: Record<string, { version: string; bin_sha256: string }> = {};
  for (const c of stableSort(checks, (x) => x.tool)) if (c.tool !== "node-tools") tools[c.tool] = { version: c.version, bin_sha256: c.binSha256 ?? "" };
  const node = checks.find((c) => c.tool === "node-tools");
  return {
    version: 1,
    mode: "host",
    platform: currentPlatform(),
    tools,
    node_tools: { lock_sha256: hashBytes(readAsset("toolchain/node-tools/package-lock.json")), eslint_version: node?.version ?? "" },
    configs: {
      eslint_baseline: hashBytes(readAsset(`toolchain/configs/eslint/${ESLINT_BASELINE}`)),
      ruff_baseline: hashBytes(readAsset("toolchain/configs/ruff/ruff.toml")),
      ...rulePackHashes(),
    },
    sandbox,
  };
}

export function writeLock(file: string, lock: ToolchainLock): void {
  writeFileSync(file, `# toolchain.lock: written by radr; part of the scope fingerprint. Do not edit.\n${stringify(lock, { lineWidth: 0, aliasDuplicateObjects: false })}`);
}

export function readLock(file: string): ToolchainLock {
  if (!existsSync(file)) throw new RefusedError(`no toolchain.lock at ${file} (run \`radr scope\` after \`radr tools install\`)`);
  return parseYaml(readFileSync(file, "utf8"), file) as ToolchainLock;
}

/** Differences between the engagement's lock and the live toolchain, one line per drifted item. */
export function diffLocks(locked: ToolchainLock, live: ToolchainLock): string[] {
  const out: string[] = [];
  const names = stableSort([...new Set([...Object.keys(locked.tools), ...Object.keys(live.tools)])], (n) => n);
  for (const n of names) {
    const a = locked.tools[n];
    const b = live.tools[n];
    if (a?.version !== b?.version || a?.bin_sha256 !== b?.bin_sha256) out.push(`${n}: locked ${a?.version ?? "absent"} ≠ live ${b?.version ?? "absent"}`);
  }
  if (locked.platform !== live.platform) out.push(`platform: locked ${locked.platform} ≠ live ${live.platform}`);
  if (locked.node_tools.lock_sha256 !== live.node_tools.lock_sha256) out.push("node-tools: lockfile changed");
  const sb = (x: ToolchainLock["sandbox"]) => (x === undefined || x === null ? "none" : `${x.runtime} ${Object.values(x.images).join(",")}`);
  if (sb(locked.sandbox) !== sb(live.sandbox)) out.push(`sandbox: locked ${sb(locked.sandbox)} ≠ live ${sb(live.sandbox)}`);
  for (const k of stableSort([...new Set([...Object.keys(locked.configs), ...Object.keys(live.configs)])], (x) => x)) {
    if (locked.configs[k] !== live.configs[k]) out.push(`config ${k}: changed`);
  }
  return out;
}
