// `radr tools install` (T3.2): download only manifest-listed artifacts, verify sha256 before
// anything is extracted or executed, install under $RADR_HOME/tools/<tool>/<version>/, and
// write an install receipt that `doctor` later verifies against.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readAsset, assetPath } from "../core/assets.js";
import { canonicalJson, hashBytes } from "../core/determinism.js";
import { RefusedError } from "../core/errors.js";
import { run } from "../core/exec.js";
import { currentPlatform, type Manifest, type Platform } from "./manifest.js";

export const RECEIPT = ".radr-install.json";
const NODE_TOOLS_FILES = ["package.json", "package-lock.json"] as const;
export const ESLINT_BASELINE = "radr-baseline.config.mjs";

export interface Receipt {
  readonly tool: string;
  readonly version: string;
  readonly platform: Platform | "any";
  readonly archive_sha256: string;
  readonly bin: string;
  readonly bin_sha256: string;
}

export type Fetcher = (url: string) => Promise<Uint8Array>;

export const httpFetcher: Fetcher = async (url) => {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new RefusedError(`download failed: GET ${url} → ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

export function toolDir(home: string, tool: string, version: string): string {
  return path.join(home, "tools", tool, version);
}

export function readReceipt(dir: string): Receipt | undefined {
  const f = path.join(dir, RECEIPT);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Receipt) : undefined;
}

export type InstallStatus = "installed" | "already-installed";

export async function installTool(home: string, name: string, manifest: Manifest, fetcher: Fetcher, platform = currentPlatform()): Promise<InstallStatus> {
  const entry = manifest.tools[name];
  if (entry === undefined) throw new RefusedError(`unknown tool "${name}"`);
  const a = entry.platforms[platform];
  const dir = toolDir(home, name, entry.version);
  const existing = readReceipt(dir);
  if (existing?.archive_sha256 === a.sha256 && existsSync(path.join(dir, existing.bin)) && hashBytes(readFileSync(path.join(dir, existing.bin))) === existing.bin_sha256) {
    return "already-installed";
  }

  const data = await fetcher(a.url);
  const got = hashBytes(data);
  if (got !== `sha256:${a.sha256}`) throw new RefusedError(`${name} ${entry.version}: checksum mismatch for ${a.url} (expected sha256:${a.sha256}, got ${got}); nothing was installed`);

  // Extract into a staging dir and rename into place, so a failed install never leaves a half-tool.
  const staging = `${dir}.staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  if (a.archive === "binary") {
    writeFileSync(path.join(staging, a.bin), data);
  } else {
    const archive = path.join(staging, `.archive.${a.archive}`);
    writeFileSync(archive, data);
    // `tar -xf` auto-detects gzip/xz; bsdtar (macOS) also extracts zip, which only macOS assets use.
    const r = await run({ command: "tar", args: ["-xf", archive, "-C", staging, "--no-same-owner"], cwd: staging, inheritEnv: ["PATH"] });
    rmSync(archive);
    if (r.outcome !== "ok") throw new RefusedError(`${name}: extracting archive failed: ${r.stderr.toString().trim()}`);
  }
  const binPath = path.join(staging, a.bin);
  if (!existsSync(binPath)) throw new RefusedError(`${name}: archive did not contain ${a.bin}`);
  chmodSync(binPath, 0o755);

  const receipt: Receipt = { tool: name, version: entry.version, platform, archive_sha256: a.sha256, bin: a.bin, bin_sha256: hashBytes(readFileSync(binPath)) };
  writeFileSync(path.join(staging, RECEIPT), canonicalJson(receipt));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.dirname(dir), { recursive: true });
  renameSync(staging, dir);
  return "installed";
}

/** The node-tools install dir is keyed by its lockfile hash, so a lock bump never reuses a stale install. */
export function nodeToolsDir(home: string): string {
  const lockHash = hashBytes(readAsset("toolchain/node-tools/package-lock.json")).slice("sha256:".length, "sha256:".length + 16);
  return path.join(home, "tools", "node-tools", lockHash);
}

export async function installNodeTools(home: string): Promise<InstallStatus> {
  const dir = nodeToolsDir(home);
  const eslintPkg = path.join(dir, "node_modules", "eslint", "package.json");
  if (existsSync(eslintPkg) && existsSync(path.join(dir, ESLINT_BASELINE))) return "already-installed";

  const staging = `${dir}.staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  for (const f of NODE_TOOLS_FILES) copyFileSync(assetPath(`toolchain/node-tools/${f}`), path.join(staging, f));
  copyFileSync(assetPath(`toolchain/configs/eslint/${ESLINT_BASELINE}`), path.join(staging, ESLINT_BASELINE));
  const r = await run({
    command: "npm",
    args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"],
    cwd: staging,
    inheritEnv: ["PATH", "HOME", "npm_config_registry", "npm_config_cache"],
    timeoutMs: 10 * 60 * 1000,
  });
  if (r.outcome !== "ok") throw new RefusedError(`node-tools: npm ci failed: ${r.stderr.toString().trim().split("\n").at(-1) ?? r.outcome}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.dirname(dir), { recursive: true });
  renameSync(staging, dir);
  return "installed";
}

/** Host-mode Python tools: only lizard (pure Python). Heavier Python tools (checkov, scancode)
 *  run in container mode only. Hashes come from the same lock as the image. Installed with
 *  `pip --target` (a venv embeds its own path and breaks when moved into place) and run as
 *  `python3 -m lizard` with PYTHONPATH pointing at the target. */
export const HOST_PY_TOOLS = ["lizard", "pathspec", "pygments"] as const; // lizard + its two (pure-Python) deps


export function pyToolsDir(home: string): string {
  const lockHash = hashBytes(readAsset("toolchain/py-tools/requirements.txt")).slice(7, 23);
  return path.join(home, "tools", "py-tools", lockHash);
}

/** The `name==version --hash=…` block for one package from the hash-locked requirements. */
export function lockBlock(name: string): string {
  const lines = readAsset("toolchain/py-tools/requirements.txt").split("\n");
  const start = lines.findIndex((l) => l.startsWith(`${name}==`));
  if (start === -1) throw new RefusedError(`${name} is not in toolchain/py-tools/requirements.txt`);
  const block = [lines[start] ?? ""];
  for (let i = start + 1; i < lines.length && (lines[i] ?? "").startsWith("    --hash="); i++) block.push(lines[i] ?? "");
  return `${block.join("\n").replace(/ \\$/, "")}\n`;
}

export async function installHostPyTools(home: string): Promise<InstallStatus | "skipped"> {
  const dir = pyToolsDir(home);
  if (existsSync(path.join(dir, "site", "lizard.py"))) return "already-installed";
  const staging = `${dir}.staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  writeFileSync(path.join(staging, "requirements.txt"), HOST_PY_TOOLS.map(lockBlock).join(""));
  const pip = await run({
    command: "python3",
    args: ["-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--no-compile", "--require-hashes", "--no-deps",
      "--target", path.join(staging, "site"), "-r", path.join(staging, "requirements.txt")],
    cwd: staging, inheritEnv: ["PATH", "HOME"], timeoutMs: 10 * 60 * 1000,
  });
  if (pip.outcome === "tool-missing") return "skipped";
  if (pip.outcome !== "ok") throw new RefusedError(`py-tools: pip failed: ${pip.stderr.toString().trim().split("\n").at(-1) ?? ""}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.dirname(dir), { recursive: true });
  renameSync(staging, dir);
  return "installed";
}
