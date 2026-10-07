// `radr scope` (T2.4) and `radr approve scope` (T2.5).

import { existsSync } from "node:fs";
import path from "node:path";
import type { Clock } from "../core/clock.js";
import { RefusedError, UsageError } from "../core/errors.js";
import { EventLog } from "../state/events.js";
import { engagementHash, readScopeInputs, scopeFingerprint } from "../state/fingerprint.js";
import { LANES, loadEngagement, writeEngagement, type EngagementDoc } from "./config.js";
import { detectStacks, type Detection } from "./detect.js";
import type { Layout } from "./home.js";
import { checkoutWorktree, mirrorSource, refsHash, resolveSha, verifyWorktree } from "./source.js";

export interface ScopeRequest {
  readonly layout: Layout;
  readonly actor: string;
  readonly clock: Clock;
  /** Path or URL of the client fork. Required on first scope. */
  readonly source?: string;
  /** Commit-ish to scope; defaults to the source's HEAD. */
  readonly rev?: string;
}

export interface ScopeResult {
  readonly doc: EngagementDoc;
  readonly fingerprint: string;
  readonly detection: Detection;
  readonly created: boolean;
}

export async function proposeScope(req: ScopeRequest): Promise<ScopeResult> {
  const l = req.layout;
  const log = new EventLog(l.events, req.clock);
  const existing = existsSync(l.engagementYml) ? loadEngagement(l.engagementYml) : undefined;

  if (!existsSync(l.mirror)) {
    const origin = req.source ?? existing?.source.origin;
    if (origin === undefined) throw new UsageError("first scope needs --source <path-or-url> (a fork or clone of the client repo)");
    await mirrorSource(normalizeOrigin(origin), l.mirror);
    log.append("source-mirrored", req.actor, { source: normalizeOrigin(origin), refs_hash: (await refsHash(l.mirror)).hash });
  } else if (req.source !== undefined && existing !== undefined && normalizeOrigin(req.source) !== existing.source.origin) {
    throw new RefusedError(`engagement already mirrors ${existing.source.origin}; start a new engagement for a different source`);
  }

  const sha = await resolveSha(l.mirror, req.rev ?? existing?.source.sha);
  await checkoutWorktree(l.mirror, l.worktree, sha);
  const detection = detectStacks(l.worktree);
  const created = log.read().find((e) => e.type === "engagement-created");
  if (created === undefined) throw new RefusedError(`${l.events}: missing engagement-created event`);

  const doc: EngagementDoc = existing
    ? { ...existing, source: { ...existing.source, sha }, stacks: detection.stacks }
    : {
        version: 1,
        client: String(created.data["client"]),
        slug: String(created.data["slug"]),
        engagement_type: "health-audit",
        tier: "standard",
        source: { origin: normalizeOrigin(req.source ?? ""), sha },
        paths: { include: ["**"], exclude: [] },
        stacks: detection.stacks,
        lanes: [...LANES],
        rubric: "v0",
        network: { mode: "offline", enforcement: "declared" },
        llm_policy: "off",
        client_licenses: [],
      };
  writeEngagement(l.engagementYml, doc);

  const fingerprint = scopeFingerprint(readScopeInputs(l));
  log.append("scope-proposed", req.actor, { fingerprint, engagement_hash: engagementHash(doc) });
  return { doc, fingerprint, detection, created: existing === undefined };
}

/** URLs and scp-style remotes (git@host:path) pass through; local paths become absolute. */
export function normalizeOrigin(origin: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(origin) || /^[^/\s]+@[^/\s]+:/.test(origin)) return origin;
  return path.resolve(origin);
}

export async function approveScope(l: Layout, actor: string, clock: Clock): Promise<{ fingerprint: string; sha: string }> {
  const inputs = readScopeInputs(l);
  const sha = inputs.engagement.source.sha;
  try {
    await verifyWorktree(l.worktree, sha);
  } catch (e) {
    const hint = ` (if you edited source.sha, run \`radr scope --rev ${sha}\` first)`;
    throw e instanceof RefusedError ? new RefusedError(e.message + hint) : e;
  }
  const fingerprint = scopeFingerprint(inputs);
  new EventLog(l.events, clock).append("scope-approved", actor, { fingerprint, sha });
  return { fingerprint, sha };
}
