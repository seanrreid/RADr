// Seeds a RADR_HOME with a toolchain that passes `doctor` and an OSV snapshot, without network.
// Tool binaries are shell stubs that print the pinned version in each tool's real format.

import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
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
};

export function seedFakeToolchain(home: string): void {
  const manifest = loadManifest();
  const platform = currentPlatform();
  for (const [name, entry] of Object.entries(manifest.tools)) {
    const print = VERSION_OUTPUT[name];
    if (print === undefined) throw new Error(`fake-toolchain: no version output for ${name}`);
    const asset = entry.platforms[platform];
    const dir = toolDir(home, name, entry.version);
    const bin = path.join(dir, asset.bin);
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, `#!/bin/sh\ncat <<'OUT'\n${print(entry.version)}\nOUT\n`);
    chmodSync(bin, 0o755);
    const receipt: Receipt = { tool: name, version: entry.version, platform, archive_sha256: asset.sha256, bin: asset.bin, bin_sha256: hashBytes(`#!/bin/sh\ncat <<'OUT'\n${print(entry.version)}\nOUT\n`) };
    writeFileSync(path.join(dir, RECEIPT), canonicalJson(receipt));
  }
  const nt = nodeToolsDir(home);
  mkdirSync(path.join(nt, "node_modules", "eslint", "bin"), { recursive: true });
  writeFileSync(path.join(nt, "node_modules", "eslint", "package.json"), '{"version":"10.12.0"}');
  copyFileSync(assetPath(`toolchain/configs/eslint/${ESLINT_BASELINE}`), path.join(nt, ESLINT_BASELINE));
}

/** A tiny OSV snapshot (not a usable DB; enough for scope/lock tests). */
export async function seedFakeSnapshot(home: string, iso = "2026-10-01T00:00:00Z"): Promise<string> {
  const info = await syncOsv(home, fixedClock(iso), (url) => Promise.resolve(new TextEncoder().encode(`fake db for ${url}`)));
  return info.id;
}

export async function seedHome(home: string): Promise<void> {
  seedFakeToolchain(home);
  await seedFakeSnapshot(home);
}
