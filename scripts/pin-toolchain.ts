// Maintainer script (T3.1): resolve each pinned tool's per-platform asset and its sha256 from the
// UPSTREAM checksum file, and write toolchain/manifest.yml. Checksums are never hand-typed.
//
//   npm run build && node dist/scripts/pin-toolchain.js
//
// To bump a tool: edit its version below, re-run, review the manifest diff, commit.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";

export const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const;
type Platform = (typeof PLATFORMS)[number];
type PerPlatform<T> = Readonly<Record<Platform, T>>;

/** sha256 per asset from the GitHub release API (`digest: "sha256:…"`), keyed by asset name. */
async function apiDigests(repo: string, tag: string): Promise<Map<string, string>> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GitHub API ${repo}@${tag}: ${res.status}`);
  const rel = (await res.json()) as { assets: { name: string; digest?: string | null }[] };
  const out = new Map<string, string>();
  for (const a of rel.assets) {
    const m = /^sha256:([0-9a-f]{64})$/.exec(a.digest ?? "");
    if (m?.[1] !== undefined) out.set(a.name, m[1]);
  }
  return out;
}

interface ToolSpec {
  readonly repo: string;
  readonly tag: string;
  readonly version: string;
  readonly license: string;
  /** Upstream checksum file name, or "github-api" to use the release API's per-asset sha256 digests
   *  (for projects that publish no checksum file; recorded as such in the manifest). */
  readonly checksums: string;
  readonly archive: "tar.gz" | "tar.xz" | "zip" | "binary" | PerPlatform<"tar.gz" | "tar.xz" | "zip">;
  /** Release asset name per platform. */
  readonly assets: Readonly<Record<Platform, string>>;
  /** Path of the executable inside the archive (or the file name for raw binaries). */
  readonly bin: (asset: string) => string;
  /** Arguments that print the version, and a regex whose group 1 must equal `version`. */
  readonly versionArgs: readonly string[];
  readonly versionPattern: string;
}

const SPECS: Readonly<Record<string, ToolSpec>> = {
  scc: {
    repo: "boyter/scc", tag: "v4.1.0", version: "4.1.0", license: "MIT", checksums: "checksums.txt", archive: "tar.gz",
    assets: { "darwin-arm64": "scc_Darwin_arm64.tar.gz", "darwin-x64": "scc_Darwin_x86_64.tar.gz", "linux-arm64": "scc_Linux_arm64.tar.gz", "linux-x64": "scc_Linux_x86_64.tar.gz" },
    bin: () => "scc", versionArgs: ["--version"], versionPattern: "scc version ([0-9.]+)",
  },
  gitleaks: {
    repo: "gitleaks/gitleaks", tag: "v8.30.1", version: "8.30.1", license: "MIT", checksums: "gitleaks_8.30.1_checksums.txt", archive: "tar.gz",
    assets: { "darwin-arm64": "gitleaks_8.30.1_darwin_arm64.tar.gz", "darwin-x64": "gitleaks_8.30.1_darwin_x64.tar.gz", "linux-arm64": "gitleaks_8.30.1_linux_arm64.tar.gz", "linux-x64": "gitleaks_8.30.1_linux_x64.tar.gz" },
    bin: () => "gitleaks", versionArgs: ["version"], versionPattern: "v?([0-9.]+)",
  },
  "osv-scanner": {
    repo: "google/osv-scanner", tag: "v2.6.0", version: "2.6.0", license: "Apache-2.0", checksums: "osv-scanner_SHA256SUMS", archive: "binary",
    assets: { "darwin-arm64": "osv-scanner_darwin_arm64", "darwin-x64": "osv-scanner_darwin_amd64", "linux-arm64": "osv-scanner_linux_arm64", "linux-x64": "osv-scanner_linux_amd64" },
    bin: (asset) => asset, versionArgs: ["--version"], versionPattern: "osv-scanner version: ([0-9.]+)",
  },
  syft: {
    repo: "anchore/syft", tag: "v1.54.1", version: "1.54.1", license: "Apache-2.0", checksums: "syft_1.54.1_checksums.txt", archive: "tar.gz",
    assets: { "darwin-arm64": "syft_1.54.1_darwin_arm64.tar.gz", "darwin-x64": "syft_1.54.1_darwin_amd64.tar.gz", "linux-arm64": "syft_1.54.1_linux_arm64.tar.gz", "linux-x64": "syft_1.54.1_linux_amd64.tar.gz" },
    bin: () => "syft", versionArgs: ["version"], versionPattern: "Version:\\s+([0-9.]+)",
  },
  // SAST engine (M3): LGPL-2.1, self-contained binaries; glibc builds for the Debian-based image.
  opengrep: {
    repo: "opengrep/opengrep", tag: "v1.30.1", version: "1.30.1", license: "LGPL-2.1", checksums: "github-api", archive: "binary",
    assets: { "darwin-arm64": "opengrep_osx_arm64", "darwin-x64": "opengrep_osx_x86", "linux-arm64": "opengrep_manylinux_aarch64", "linux-x64": "opengrep_manylinux_x86" },
    bin: (asset) => asset, versionArgs: ["--version"], versionPattern: "([0-9]+\\.[0-9]+\\.[0-9]+)",
  },
  // Report rendering (M2): pandoc publishes no checksum file, Typst neither; both use GitHub's
  // per-asset digests. pandoc is GPL-2.0+ and is only ever invoked as a separate process.
  pandoc: {
    repo: "jgm/pandoc", tag: "3.12", version: "3.12", license: "GPL-2.0-or-later", checksums: "github-api",
    archive: { "darwin-arm64": "zip", "darwin-x64": "zip", "linux-arm64": "tar.gz", "linux-x64": "tar.gz" },
    assets: { "darwin-arm64": "pandoc-3.12-arm64-macOS.zip", "darwin-x64": "pandoc-3.12-x86_64-macOS.zip", "linux-arm64": "pandoc-3.12-linux-arm64.tar.gz", "linux-x64": "pandoc-3.12-linux-amd64.tar.gz" },
    bin: (asset) => (asset.endsWith(".zip") ? `${asset.replace(/-macOS\.zip$/, "")}/bin/pandoc` : "pandoc-3.12/bin/pandoc"),
    versionArgs: ["--version"], versionPattern: "pandoc ([0-9.]+)",
  },
  typst: {
    repo: "typst/typst", tag: "v0.15.1", version: "0.15.1", license: "Apache-2.0", checksums: "github-api", archive: "tar.xz",
    assets: { "darwin-arm64": "typst-aarch64-apple-darwin.tar.xz", "darwin-x64": "typst-x86_64-apple-darwin.tar.xz", "linux-arm64": "typst-aarch64-unknown-linux-musl.tar.xz", "linux-x64": "typst-x86_64-unknown-linux-musl.tar.xz" },
    bin: (asset) => `${asset.replace(/\.tar\.xz$/, "")}/typst`, versionArgs: ["--version"], versionPattern: "typst ([0-9.]+)",
  },
  ruff: {
    repo: "astral-sh/ruff", tag: "0.16.10", version: "0.16.10", license: "MIT", checksums: "sha256.sum", archive: "tar.gz",
    assets: { "darwin-arm64": "ruff-aarch64-apple-darwin.tar.gz", "darwin-x64": "ruff-x86_64-apple-darwin.tar.gz", "linux-arm64": "ruff-aarch64-unknown-linux-musl.tar.gz", "linux-x64": "ruff-x86_64-unknown-linux-musl.tar.gz" },
    bin: (asset) => `${asset.replace(/\.tar\.gz$/, "")}/ruff`, versionArgs: ["--version"], versionPattern: "ruff ([0-9.]+)",
  },
};

/** Parse `sha256  filename` lines (GNU coreutils / goreleaser format; `*` binary marker allowed). */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) out.set(path.basename(m[2]), m[1]);
  }
  return out;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return res.text();
}

async function main(): Promise<void> {
  const tools: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(SPECS)) {
    const base = `https://github.com/${spec.repo}/releases/download/${spec.tag}`;
    const sums = spec.checksums === "github-api" ? await apiDigests(spec.repo, spec.tag) : parseChecksums(await fetchText(`${base}/${spec.checksums}`));
    const platforms: Record<string, unknown> = {};
    for (const p of PLATFORMS) {
      const asset = spec.assets[p];
      const sha256 = sums.get(asset);
      if (sha256 === undefined) throw new Error(`${name}: no checksum for ${asset} in ${spec.checksums}`);
      platforms[p] = { url: `${base}/${asset}`, sha256, archive: typeof spec.archive === "string" ? spec.archive : spec.archive[p], bin: spec.bin(asset) };
    }
    tools[name] = {
      version: spec.version, license: spec.license, source: `https://github.com/${spec.repo}`, checksums_from: spec.checksums === "github-api" ? `https://api.github.com/repos/${spec.repo}/releases/tags/${spec.tag} (asset digests)` : `${base}/${spec.checksums}`,
      version_args: spec.versionArgs, version_pattern: spec.versionPattern, platforms,
    };
    process.stdout.write(`pinned ${name} ${spec.version}\n`);
  }
  const header = "# toolchain/manifest.yml: GENERATED by scripts/pin-toolchain.ts. Do not edit by hand.\n" +
    "# Every sha256 comes from the upstream release's own checksum file (checksums_from).\n";
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  writeFileSync(path.join(root, "toolchain/manifest.yml"), header + stringify({ version: 1, tools }, { lineWidth: 0, aliasDuplicateObjects: false }));
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
