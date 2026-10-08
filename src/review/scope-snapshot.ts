// raw/<run>/scope.json (M6): what a run was scoped with, written when the run starts, so
// `radr verify` can prove a re-run differs only in the commit, and a baseline knows its commit.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson, hashBytes } from "../core/determinism.js";
import { parseYaml } from "../core/yaml.js";
import type { EngagementDoc } from "../engagement/config.js";
import type { Layout } from "../engagement/home.js";

/** raw/<run>/scope.json: the engagement doc and both locks a run was scoped with (M6 verify). */
export interface ScopeSnapshot {
  readonly engagement: EngagementDoc;
  readonly toolchain_lock: unknown;
  readonly snapshots_lock: unknown;
}

export function writeScopeSnapshot(l: Layout, runId: string, doc: EngagementDoc): { ref: string; hash: string } {
  const read = (f: string): unknown => (existsSync(f) ? parseYaml(readFileSync(f, "utf8"), f) : null);
  const snap: ScopeSnapshot = { engagement: doc, toolchain_lock: read(l.toolchainLock), snapshots_lock: read(l.snapshotsLock) };
  const dir = path.join(l.raw, runId);
  mkdirSync(dir, { recursive: true });
  const body = canonicalJson(snap);
  writeFileSync(path.join(dir, "scope.json"), body);
  return { ref: `raw/${runId}/scope.json`, hash: hashBytes(body) };
}

export function readScopeSnapshot(l: Layout, runId: string): ScopeSnapshot | null {
  const f = path.join(l.raw, runId, "scope.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as ScopeSnapshot) : null;
}
