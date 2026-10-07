// The scope fingerprint (PRD §7 Gate 1, M1 AC8): one hash over everything that defines what a
// run will scan and how. Lock files are hashed from disk at compute time, so editing
// toolchain.lock or snapshots.lock after approval closes the gate just like editing
// engagement.yml does.

import { existsSync, readFileSync } from "node:fs";
import { hash, hashBytes } from "../core/determinism.js";
import { loadEngagement, type EngagementDoc } from "../engagement/config.js";
import type { Layout } from "../engagement/home.js";

/** Bump when the set of fingerprinted inputs changes, so old approvals can't match new scopes. */
export const FINGERPRINT_SCHEMA = 1;

export interface ScopeInputs {
  readonly engagement: EngagementDoc;
  readonly toolchainLockHash: string | null;
  readonly snapshotsLockHash: string | null;
}

export function readScopeInputs(l: Layout): ScopeInputs {
  const fileHash = (f: string): string | null => (existsSync(f) ? hashBytes(readFileSync(f)) : null);
  return {
    engagement: loadEngagement(l.engagementYml),
    toolchainLockHash: fileHash(l.toolchainLock),
    snapshotsLockHash: fileHash(l.snapshotsLock),
  };
}

export function scopeFingerprint(inputs: ScopeInputs): string {
  return hash({
    schema: FINGERPRINT_SCHEMA,
    engagement: inputs.engagement,
    toolchain_lock: inputs.toolchainLockHash,
    snapshots_lock: inputs.snapshotsLockHash,
  });
}

export function engagementHash(doc: EngagementDoc): string {
  return hash(doc);
}
