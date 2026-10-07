// `radr db sync` (T3.4): snapshot the OSV vulnerability databases on a connected machine so the
// sca lane can run fully offline. Each snapshot is immutable and content-addressed; engagements
// pin one via snapshots.lock, which is part of the scope fingerprint (PRD §14.1).
//
// Layout matches osv-scanner v2's local DB cache (OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY, which v2
// resolves under an "osv-scalibr" subdirectory; verified against osv-scanner 2.6.0):
//   $RADR_HOME/snapshots/osv/<id>/osv-scalibr/<ecosystem>/all.zip
//   $RADR_HOME/snapshots/osv/<id>/snapshot.json

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import type { Clock } from "../core/clock.js";
import { canonicalJson, hash, hashBytes, stableSort } from "../core/determinism.js";
import { RefusedError } from "../core/errors.js";
import { parseYaml } from "../core/yaml.js";
import type { Fetcher } from "./install.js";
import type { ContextSnapshot } from "./vulnctx.js";

export const OSV_ECOSYSTEMS = ["npm", "PyPI"] as const;
/** osv-scanner v2 reads $OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY/osv-scalibr/<ecosystem>/all.zip. */
export const OSV_SUBDIR = "osv-scalibr";
const OSV_BUCKET = "https://osv-vulnerabilities.storage.googleapis.com";

export interface SnapshotInfo {
  readonly id: string;
  readonly fetched_at: string;
  readonly ecosystems: Readonly<Record<string, { readonly url: string; readonly sha256: string; readonly bytes: number }>>;
}

export function osvRoot(home: string): string {
  return path.join(home, "snapshots", "osv");
}

export async function syncOsv(home: string, clock: Clock, fetcher: Fetcher, ecosystems: readonly string[] = OSV_ECOSYSTEMS): Promise<SnapshotInfo> {
  const fetchedAt = clock.nowIso();
  const staging = path.join(osvRoot(home), `.staging-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  const entries: Record<string, { url: string; sha256: string; bytes: number }> = {};
  for (const eco of ecosystems) {
    const url = `${OSV_BUCKET}/${eco}/all.zip`;
    const data = await fetcher(url);
    const dir = path.join(staging, OSV_SUBDIR, eco);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "all.zip"), data);
    entries[eco] = { url, sha256: hashBytes(data), bytes: data.byteLength };
  }
  const id = `${fetchedAt.slice(0, 10).replace(/-/g, "")}-${hash(entries).slice("sha256:".length, "sha256:".length + 12)}`;
  const info: SnapshotInfo = { id, fetched_at: fetchedAt, ecosystems: entries };
  writeFileSync(path.join(staging, "snapshot.json"), canonicalJson(info));
  const final = path.join(osvRoot(home), id);
  if (existsSync(final)) {
    rmSync(staging, { recursive: true, force: true }); // identical content already snapshotted
  } else {
    renameSync(staging, final);
  }
  return info;
}

export function listSnapshots(home: string): SnapshotInfo[] {
  const root = osvRoot(home);
  if (!existsSync(root)) return [];
  const infos = readdirSync(root)
    .filter((d) => !d.startsWith(".") && existsSync(path.join(root, d, "snapshot.json")))
    .map((d) => JSON.parse(readFileSync(path.join(root, d, "snapshot.json"), "utf8")) as SnapshotInfo);
  return stableSort(infos, (s) => [s.fetched_at, s.id]);
}

/** Re-hash a snapshot's files; refuses if anything was altered after sync. */
export function verifySnapshot(home: string, id: string): SnapshotInfo {
  const dir = path.join(osvRoot(home), id);
  const f = path.join(dir, "snapshot.json");
  if (!existsSync(f)) throw new RefusedError(`OSV snapshot ${id} not found (run \`radr db sync\`)`);
  const info = JSON.parse(readFileSync(f, "utf8")) as SnapshotInfo;
  for (const [eco, e] of Object.entries(info.ecosystems)) {
    const zip = path.join(dir, OSV_SUBDIR, eco, "all.zip");
    if (!existsSync(zip) || hashBytes(readFileSync(zip)) !== e.sha256) throw new RefusedError(`OSV snapshot ${id}: ${eco} database is missing or altered`);
  }
  return info;
}

export interface SnapshotsLock {
  readonly version: 1;
  readonly osv: { readonly id: string; readonly fetched_at: string; readonly ecosystems: Readonly<Record<string, string>> } | null;
  /** EPSS / KEV (M2). Absent in M1-era locks; null = not pinned (fail-open, no promotion). */
  readonly epss?: { readonly id: string; readonly fetched_at: string; readonly sha256: string; readonly published: string } | null;
  readonly kev?: { readonly id: string; readonly fetched_at: string; readonly sha256: string; readonly published: string } | null;
}

type PinnedContextSnap = { readonly id: string; readonly fetched_at: string; readonly sha256: string; readonly published: string };

export function buildSnapshotsLock(info: SnapshotInfo | undefined, epss?: ContextSnapshot, kev?: ContextSnapshot): SnapshotsLock {
  const pin = (s: ContextSnapshot | undefined): PinnedContextSnap | null =>
    s === undefined ? null : { id: s.id, fetched_at: s.fetched_at, sha256: s.sha256, published: s.published };
  let osv: SnapshotsLock["osv"] = null;
  if (info !== undefined) {
    const ecosystems: Record<string, string> = {};
    for (const [eco, e] of Object.entries(info.ecosystems)) ecosystems[eco] = e.sha256;
    osv = { id: info.id, fetched_at: info.fetched_at, ecosystems };
  }
  return { version: 1, osv, epss: pin(epss), kev: pin(kev) };
}

export function writeSnapshotsLock(file: string, lock: SnapshotsLock): void {
  writeFileSync(file, `# snapshots.lock: written by radr; part of the scope fingerprint. Do not edit.\n${stringify(lock, { lineWidth: 0 })}`);
}

export function readSnapshotsLock(file: string): SnapshotsLock {
  if (!existsSync(file)) throw new RefusedError(`no snapshots.lock at ${file} (run \`radr scope\` after \`radr db sync\`)`);
  return parseYaml(readFileSync(file, "utf8"), file) as SnapshotsLock;
}
