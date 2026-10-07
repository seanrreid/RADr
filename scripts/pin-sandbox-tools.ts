// Maintainer script (M3 W5): pin the extra tools baked into the stack sandbox images and write
// toolchain/sandbox-tools.yml. Every sha256 comes from upstream: a release checksum file, GitHub's
// per-asset digests, or (Maven) Apache's published sha512, verified here before recording sha256.
//
//   npm run build && node dist/scripts/pin-sandbox-tools.js

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { hashBytes } from "../src/core/determinism.js";
import { parseChecksums } from "./pin-toolchain.js";

type Arch = "linux-x64" | "linux-arm64";
interface Pinned { url: string; sha256: string; archive: "tar.gz" | "zip" | "binary"; bin: string }

async function text(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return res.text();
}

async function githubDigests(repo: string, tag: string): Promise<Map<string, string>> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GitHub API ${repo}@${tag}: ${res.status}`);
  const rel = (await res.json()) as { assets: { name: string; digest?: string | null }[] };
  return new Map(rel.assets.flatMap((a) => (/^sha256:[0-9a-f]{64}$/.test(a.digest ?? "") ? [[a.name, (a.digest ?? "").slice(7)] as const] : [])));
}

async function need(map: Map<string, string>, name: string): Promise<string> {
  const v = map.get(name);
  if (v === undefined) throw new Error(`no checksum for ${name}`);
  return Promise.resolve(v);
}

const GOLANGCI = "2.14.0";
const PMD = "7.28.0";
const MAVEN = "3.10.0";
const PHPSTAN = "2.3.0";
const COMPOSER = "2.10.3";

async function main(): Promise<void> {
  const tools: Record<string, { version: string; license: string; source: string; stacks: string[]; platforms: Record<Arch, Pinned> }> = {};

  const gSums = parseChecksums(await text(`https://github.com/golangci/golangci-lint/releases/download/v${GOLANGCI}/golangci-lint-${GOLANGCI}-checksums.txt`));
  const g = async (arch: string): Promise<Pinned> => {
    const asset = `golangci-lint-${GOLANGCI}-linux-${arch}.tar.gz`;
    return { url: `https://github.com/golangci/golangci-lint/releases/download/v${GOLANGCI}/${asset}`, sha256: await need(gSums, asset), archive: "tar.gz", bin: `golangci-lint-${GOLANGCI}-linux-${arch}/golangci-lint` };
  };
  tools["golangci-lint"] = { version: GOLANGCI, license: "GPL-3.0 (run as a separate process only)", source: "https://github.com/golangci/golangci-lint", stacks: ["go"],
    platforms: { "linux-x64": await g("amd64"), "linux-arm64": await g("arm64") } };

  // Architecture-independent artifacts: the same pin for both platforms.
  const both = (p: Pinned): Record<Arch, Pinned> => ({ "linux-x64": p, "linux-arm64": p });
  const pmd = await githubDigests("pmd/pmd", `pmd_releases/${PMD}`);
  tools["pmd"] = { version: PMD, license: "BSD-4-Clause-style (PMD license) + Apache-2.0", source: "https://github.com/pmd/pmd", stacks: ["java-kotlin"],
    platforms: both({ url: `https://github.com/pmd/pmd/releases/download/pmd_releases%2F${PMD}/pmd-dist-${PMD}-bin.zip`, sha256: await need(pmd, `pmd-dist-${PMD}-bin.zip`), archive: "zip", bin: `pmd-bin-${PMD}/bin/pmd` }) };

  // Downloaded from Maven Central (CDN; archive.apache.org is very slow), verified against the
  // sha512 Apache publishes on its own distribution server.
  const mavenUrl = `https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/${MAVEN}/apache-maven-${MAVEN}-bin.tar.gz`;
  const published512 = (await text(`https://archive.apache.org/dist/maven/maven-3/${MAVEN}/binaries/apache-maven-${MAVEN}-bin.tar.gz.sha512`)).trim().split(/\s+/)[0] ?? "";
  const tarball = new Uint8Array(await (await fetch(mavenUrl)).arrayBuffer());
  // eslint-disable-next-line no-restricted-syntax -- Apache publishes sha512 only; determinism.ts hashes sha256.
  if (createHash("sha512").update(tarball).digest("hex") !== published512) throw new Error("maven: sha512 does not match Apache's published checksum");
  tools["maven"] = { version: MAVEN, license: "Apache-2.0", source: "https://maven.apache.org", stacks: ["java-kotlin"],
    platforms: both({ url: mavenUrl, sha256: hashBytes(tarball).slice("sha256:".length), archive: "tar.gz", bin: `apache-maven-${MAVEN}/bin/mvn` }) };

  const phpstan = await githubDigests("phpstan/phpstan", PHPSTAN);
  tools["phpstan"] = { version: PHPSTAN, license: "MIT", source: "https://github.com/phpstan/phpstan", stacks: ["php"],
    platforms: both({ url: `https://github.com/phpstan/phpstan/releases/download/${PHPSTAN}/phpstan.phar`, sha256: await need(phpstan, "phpstan.phar"), archive: "binary", bin: "phpstan.phar" }) };
  const composer = await githubDigests("composer/composer", COMPOSER);
  tools["composer"] = { version: COMPOSER, license: "MIT", source: "https://github.com/composer/composer", stacks: ["php"],
    platforms: both({ url: `https://github.com/composer/composer/releases/download/${COMPOSER}/composer.phar`, sha256: await need(composer, "composer.phar"), archive: "binary", bin: "composer.phar" }) };

  for (const [n, t] of Object.entries(tools)) process.stdout.write(`pinned ${n} ${t.version}\n`);
  const header = "# toolchain/sandbox-tools.yml: GENERATED by scripts/pin-sandbox-tools.ts. Do not edit by hand.\n" +
    "# Extra tools baked into the stack sandbox images; each sha256 is checked during the image build.\n";
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  writeFileSync(path.join(root, "toolchain/sandbox-tools.yml"), header + stringify({ version: 1, tools }, { lineWidth: 0, aliasDuplicateObjects: false }));
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
