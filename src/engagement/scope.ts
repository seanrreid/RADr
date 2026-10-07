// `radr scope` (T2.4) and `radr approve scope` (T2.5).

import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { hashBytes } from "../core/determinism.js";
import { STACK_ECOSYSTEM, buildSnapshotsLock, listSnapshots, verifySnapshot, writeSnapshotsLock } from "../toolchain/db.js";
import { buildLock, doctor, writeLock, type ToolchainLock } from "../toolchain/doctor.js";
import { currentImage } from "../toolchain/image.js";
import { loadManifest } from "../toolchain/manifest.js";
import { ESLINT_BASELINE } from "../toolchain/install.js";
import { readAsset } from "../core/assets.js";
import { rulePackHashes } from "../rules/pack.js";
import { listContext, verifyContext } from "../toolchain/vulnctx.js";
import type { Clock } from "../core/clock.js";
import { RefusedError, UsageError } from "../core/errors.js";
import { EventLog } from "../state/events.js";
import { engagementHash, readScopeInputs, scopeFingerprint } from "../state/fingerprint.js";
import { CONTAINER_LANES, LANES, OPTIONAL_LANES, SANDBOX_LANES, loadEngagement, writeEngagement, type EngagementDoc } from "./config.js";
import { detectRuntime, sandboxLockEntry, type Runtime } from "../sandbox/runtime.js";
import { proposeRecipe } from "../sandbox/recipe.js";
import { scopeUsesSandbox } from "../sandbox/stacks.js";
import { stackImages } from "../sandbox/stack-images.js";
import { listDeps, verifyDeps } from "../sandbox/deps.js";
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
  /** RADR_HOME, for the toolchain and vulnerability-DB snapshots. */
  readonly home: string;
  /** Host env, for reaching a container runtime (Podman/Docker). */
  readonly env?: NodeJS.ProcessEnv;
  /** OSV snapshot id to pin; defaults to the newest. */
  readonly snapshot?: string;
}

export interface ScopeResult {
  readonly doc: EngagementDoc;
  readonly fingerprint: string;
  readonly detection: Detection;
  readonly created: boolean;
  /** Why a lock could not be written yet (approval will refuse until fixed). */
  readonly warnings: readonly string[];
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
  const runtime = await detectRuntime(req.env ?? {});
  const recipe = proposeRecipe(l.worktree, detection.stacks, detection.manifests);
  const canSandbox = runtime !== undefined && Object.keys(recipe).length > 0;
  const created = log.read().find((e) => e.type === "engagement-created");
  if (created === undefined) throw new RefusedError(`${l.events}: missing engagement-created event`);

  const doc: EngagementDoc = existing
    ? { ...existing, source: { ...existing.source, sha }, stacks: detection.stacks, ...(existing.build === undefined && canSandbox ? { build: recipe } : {}) }
    : {
        version: 1,
        client: String(created.data["client"]),
        slug: String(created.data["slug"]),
        engagement_type: "health-audit",
        tier: "standard",
        source: { origin: normalizeOrigin(req.source ?? ""), sha },
        paths: { include: ["**"], exclude: [] },
        stacks: detection.stacks,
        // Host mode by default: image-only lanes and opt-in lanes are added by the consultant.
        lanes: LANES.filter((x) => (canSandbox || !SANDBOX_LANES.includes(x)) && !CONTAINER_LANES.includes(x) && !OPTIONAL_LANES.includes(x)),
        rubric: "v1",
        network: { mode: "offline", enforcement: "declared" },
        llm_policy: "off",
        client_licenses: [],
        ...(canSandbox ? { build: recipe } : {}),
        lint_modes: ["baseline"],
      };
  writeEngagement(l.engagementYml, doc);
  const warnings = await writeLocks(req, doc, log, runtime);

  const fingerprint = scopeFingerprint(readScopeInputs(l));
  log.append("scope-proposed", req.actor, { fingerprint, engagement_hash: engagementHash(doc) });
  return { doc, fingerprint, detection, created: existing === undefined, warnings };
}

/**
 * Write toolchain.lock and snapshots.lock for the scope. A lock that can't be written yet (tools
 * not installed, no DB snapshot) is removed, not left stale, and reported as a warning;
 * approveScope refuses until it exists.
 */
async function writeLocks(req: ScopeRequest, doc: EngagementDoc, log: EventLog, runtime: Runtime | undefined): Promise<string[]> {
  const l = req.layout;
  const warnings: string[] = [];
  const usesSandbox = scopeUsesSandbox(doc);
  if (usesSandbox && runtime === undefined) warnings.push("sandboxed lanes are enabled but no container runtime is reachable (start Podman/Docker, then `radr scope` again)");
  try {
    const lock = doc.network.enforcement === "container"
      ? await containerLock(req.home, runtime, usesSandbox ? sandboxLockEntry(runtime, stackImages(req.home)) : null)
      : buildLock(await doctor(req.home), usesSandbox ? sandboxLockEntry(runtime, stackImages(req.home)) : null);
    writeLock(l.toolchainLock, lock);
    log.append("toolchain-locked", req.actor, { lock_hash: hashBytes(readFileSync(l.toolchainLock)), mode: lock.mode });
  } catch (e) {
    if (!(e instanceof RefusedError)) throw e;
    rmSync(l.toolchainLock, { force: true });
    warnings.push(`${e.message}; run \`radr tools install\`, then \`radr scope\` again`);
  }

  const needsOsv = doc.lanes.includes("sca");
  const snapshots = listSnapshots(req.home);
  const chosen = req.snapshot !== undefined ? verifySnapshot(req.home, req.snapshot) : snapshots.at(-1);
  if (chosen !== undefined) verifySnapshot(req.home, chosen.id);
  // Each snapshot is judged independently, so every gap is reported in one scope pass.
  const missingOsv = needsOsv && chosen === undefined;
  if (missingOsv) warnings.push("no OSV vulnerability DB snapshot (needed by the sca lane); run `radr db sync`, then `radr scope` again");
  const gaps = needsOsv && chosen !== undefined ? doc.stacks.flatMap((s) => STACK_ECOSYSTEM[s] ?? []).filter((e) => !Object.hasOwn(chosen.ecosystems, e)) : [];
  if (gaps.length > 0) warnings.push(`OSV snapshot ${chosen?.id ?? ""} has no ${[...new Set(gaps)].join(", ")} database: the sca lane will refuse to run (run \`radr db sync\`, then \`radr scope\` again)`);

  // EPSS/KEV are fail-open (P7): pin the newest if present, otherwise warn and pin null.
  const epss = needsOsv ? listContext(req.home, "epss").at(-1) : undefined;
  const kev = needsOsv ? listContext(req.home, "kev").at(-1) : undefined;
  if (epss !== undefined) verifyContext(req.home, "epss", epss.id);
  if (kev !== undefined) verifyContext(req.home, "kev", kev.id);
  if (needsOsv && (epss === undefined || kev === undefined)) {
    warnings.push(`no ${[epss === undefined ? "EPSS" : "", kev === undefined ? "KEV" : ""].filter(Boolean).join("/")} snapshot: severity promotion for exploitability will be skipped (run \`radr db sync\`)`);
  }

  const offlineSandbox = usesSandbox && doc.network.mode === "offline";
  const deps = offlineSandbox ? listDeps(req.home, l.id).at(-1) : undefined;
  if (deps !== undefined) verifyDeps(req.home, l.id, deps.id);
  if (offlineSandbox && deps === undefined) warnings.push("no dependency snapshot for offline sandbox installs (run `radr deps warm`, then `radr scope` again)");

  // Without OSV the sca lane can't run, so there is no lock to approve against (approve refuses).
  if (missingOsv) rmSync(l.snapshotsLock, { force: true });
  else writeSnapshotsLock(l.snapshotsLock, buildSnapshotsLock(needsOsv ? chosen : undefined, epss, kev, deps));
  return warnings;
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
  if (inputs.toolchainLockHash === null) throw new RefusedError("no toolchain.lock: run `radr tools install`, then `radr scope` again");
  if (inputs.snapshotsLockHash === null) throw new RefusedError("no snapshots.lock: run `radr db sync`, then `radr scope` again");
  const fingerprint = scopeFingerprint(inputs);
  new EventLog(l.events, clock).append("scope-approved", actor, { fingerprint, sha });
  return { fingerprint, sha };
}

/**
 * Container mode lock (M3): the toolchain image built from the CURRENT repo context. Tool
 * versions come from the manifest the image was built from; the image ID is the drift check.
 */
async function containerLock(home: string, runtime: Runtime | undefined, sandbox: ToolchainLock["sandbox"]): Promise<ToolchainLock> {
  if (runtime === undefined) throw new RefusedError("container mode needs Podman or Docker (start it, then `radr scope` again)");
  const img = await currentImage(home, runtime);
  if (img === undefined) throw new RefusedError("no toolchain image for this radr version; run `radr tools build-image`");
  const tools: Record<string, { version: string; bin_sha256: string }> = {};
  for (const [name, t] of Object.entries(loadManifest().tools)) tools[name] = { version: t.version, bin_sha256: img.id };
  return {
    version: 1, mode: "container", platform: img.platform, tools,
    node_tools: { lock_sha256: hashBytes(readAsset("toolchain/node-tools/package-lock.json")), eslint_version: "10.12.0" },
    configs: {
      eslint_baseline: hashBytes(readAsset(`toolchain/configs/eslint/${ESLINT_BASELINE}`)),
      ruff_baseline: hashBytes(readAsset("toolchain/configs/ruff/ruff.toml")),
      ...rulePackHashes(),
    },
    sandbox: sandbox ?? null,
    image: { tag: img.tag, id: img.id, context_hash: img.contextHash },
  };
}
