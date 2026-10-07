// Seeds a RADR_HOME with a toolchain that passes `doctor` and an OSV snapshot, without network.
// Each fake binary prints the pinned version in the real tool's format when asked, and otherwise
// runs a scriptable behavior (default: succeed with empty output), so runner tests can drive
// every lane outcome without the real tools.

import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assetPath } from "../../src/core/assets.js";
import { canonicalJson, hashBytes } from "../../src/core/determinism.js";
import { fixedClock } from "../../src/core/clock.js";
import { syncOsv } from "../../src/toolchain/db.js";
import { ESLINT_BASELINE, RECEIPT, nodeToolsDir, toolDir, type Receipt } from "../../src/toolchain/install.js";
import { currentPlatform, loadManifest } from "../../src/toolchain/manifest.js";

/** What each real tool prints for its version command (verified against the pinned releases). */
const VERSION_OUTPUT: Readonly<Record<string, (v: string) => string>> = {
  scc: (v) => `scc version ${v}`,
  gitleaks: (v) => v,
  "osv-scanner": (v) => `osv-scanner version: ${v}\ncommit: n/a`,
  syft: (v) => `Application:   syft\nVersion:       ${v}`,
  ruff: (v) => `ruff ${v}`,
  pandoc: (v) => `pandoc ${v}\nFeatures: +server +lua`,
  typst: (v) => `typst ${v} (abcdef12)`,
};

/** Default behaviors: valid, empty results in each tool's real output format. */
export const DEFAULT_BEHAVIOR: Readonly<Record<string, string>> = {
  scc: "echo '[]'",
  ruff: "echo '[]'",
  gitleaks: 'while [ $# -gt 0 ]; do if [ "$1" = "--report-path" ]; then shift; echo "[]" > "$1"; fi; shift; done',
  "osv-scanner": "echo '{\"results\":[]}'",
  syft: "exit 0",
};

function script(tool: string, version: string, behavior: string): string {
  const print = VERSION_OUTPUT[tool];
  if (print === undefined) throw new Error(`fake-toolchain: no version output for ${tool}`);
  return `#!/bin/sh\ncase "$1" in --version|version)\ncat <<'OUT'\n${print(version)}\nOUT\nexit 0;;\nesac\n${behavior}\n`;
}

/** Install (or replace) a fake tool with a behavior, keeping its receipt consistent. */
export function setFakeTool(home: string, tool: string, behavior = DEFAULT_BEHAVIOR[tool] ?? "exit 0"): string {
  const entry = loadManifest().tools[tool];
  if (entry === undefined) throw new Error(`unknown tool ${tool}`);
  const platform = currentPlatform();
  const asset = entry.platforms[platform];
  const dir = toolDir(home, tool, entry.version);
  const bin = path.join(dir, asset.bin);
  const body = script(tool, entry.version, behavior);
  mkdirSync(path.dirname(bin), { recursive: true });
  writeFileSync(bin, body);
  chmodSync(bin, 0o755);
  const receipt: Receipt = { tool, version: entry.version, platform, archive_sha256: asset.sha256, bin: asset.bin, bin_sha256: hashBytes(body) };
  writeFileSync(path.join(dir, RECEIPT), canonicalJson(receipt));
  return bin;
}

/** Change a fake tool's behavior WITHOUT updating its receipt: doctor will report drift. */
export function tamperFakeTool(home: string, tool: string, behavior: string): void {
  const entry = loadManifest().tools[tool];
  if (entry === undefined) throw new Error(`unknown tool ${tool}`);
  const bin = path.join(toolDir(home, tool, entry.version), entry.platforms[currentPlatform()].bin);
  writeFileSync(bin, script(tool, entry.version, behavior));
}

export function seedFakeToolchain(home: string): void {
  for (const tool of Object.keys(loadManifest().tools)) setFakeTool(home, tool);
  const nt = nodeToolsDir(home);
  mkdirSync(path.join(nt, "node_modules", "eslint", "bin"), { recursive: true });
  writeFileSync(path.join(nt, "node_modules", "eslint", "package.json"), '{"version":"10.12.0"}');
  writeFileSync(path.join(nt, "node_modules", "eslint", "bin", "eslint.js"), "process.stdout.write('[]');\n");
  copyFileSync(assetPath(`toolchain/configs/eslint/${ESLINT_BASELINE}`), path.join(nt, ESLINT_BASELINE));
}

/** An OSV snapshot. Defaults to placeholder bytes; pass real zips for scanning tests. */
export async function seedFakeSnapshot(home: string, iso = "2026-10-01T00:00:00Z", zips?: Readonly<Record<string, string>>): Promise<string> {
  const info = await syncOsv(home, fixedClock(iso), (url) => {
    const eco = url.split("/").at(-2) ?? "";
    const zip = zips?.[eco];
    return Promise.resolve(zip !== undefined ? new Uint8Array(readFileSync(zip)) : new TextEncoder().encode(`fake db for ${url}`));
  });
  return info.id;
}

export async function seedHome(home: string): Promise<void> {
  seedFakeToolchain(home);
  await seedFakeSnapshot(home);
}
