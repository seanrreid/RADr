// EPSS and CISA KEV snapshots (M2 AC2): vulnerability context for rubric v1 promotion.
// Same discipline as OSV snapshots: fetched on a connected machine, content-addressed,
// verified on use, pinned per engagement in snapshots.lock. A missing snapshot is a visible
// fail-open gap (PRD P7): severities are computed without promotion, with epss/kev = null.
//
//   $RADR_HOME/snapshots/epss/<id>/{epss.csv.gz, snapshot.json}
//   $RADR_HOME/snapshots/kev/<id>/{kev.json, snapshot.json}

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { Clock } from "../core/clock.js";
import { canonicalJson, hashBytes, stableSort } from "../core/determinism.js";
import { RefusedError } from "../core/errors.js";
import type { VulnContext } from "../rubric/rubric.js";
import type { Fetcher } from "./install.js";

export const EPSS_URL = "https://epss.empiricalsecurity.com/epss_scores-current.csv.gz";
export const KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";

export type ContextKind = "epss" | "kev";
const FILE: Readonly<Record<ContextKind, string>> = { epss: "epss.csv.gz", kev: "kev.json" };

export interface ContextSnapshot {
  readonly kind: ContextKind;
  readonly id: string;
  readonly fetched_at: string;
  readonly sha256: string;
  /** EPSS score_date or KEV catalogVersion, as published. */
  readonly published: string;
  readonly rows: number;
}

/** "0.21333" → 2133 basis points, rounded half-up at 4 decimals, with no floating point. */
export function decimalToBp(s: string): number {
  const m = /^([01])(?:\.(\d+))?$/.exec(s);
  if (m?.[1] === undefined) throw new RefusedError(`invalid probability "${s}"`);
  const frac = (m[2] ?? "").padEnd(5, "0");
  let bp = Number.parseInt(m[1], 10) * 10000 + Number.parseInt(frac.slice(0, 4), 10);
  if (Number.parseInt(frac[4] ?? "0", 10) >= 5) bp += 1;
  if (bp > 10000) throw new RefusedError(`probability out of range "${s}"`);
  return bp;
}

interface Parsed {
  readonly published: string;
  readonly rows: number;
}

export function parseEpss(gz: Uint8Array): { published: string; scores: Map<string, number> } {
  let text: string;
  try {
    text = gunzipSync(gz).toString("utf8");
  } catch {
    throw new RefusedError("EPSS snapshot is not valid gzip");
  }
  const lines = text.split("\n");
  const published = /score_date:([0-9T:\-Z.]+)/.exec(lines[0] ?? "")?.[1];
  if (published === undefined || lines[1]?.trim() !== "cve,epss,percentile") throw new RefusedError("EPSS file has an unexpected header");
  const scores = new Map<string, number>();
  for (const line of lines.slice(2)) {
    if (line === "") continue;
    const [cve, epss] = line.split(",");
    if (cve === undefined || epss === undefined || !/^CVE-\d{4}-\d+$/.test(cve)) throw new RefusedError(`EPSS row is malformed: ${line.slice(0, 60)}`);
    scores.set(cve, decimalToBp(epss));
  }
  return { published, scores };
}

export function parseKev(json: Uint8Array): { published: string; cves: Set<string> } {
  let doc: unknown;
  try {
    doc = JSON.parse(Buffer.from(json).toString("utf8"));
  } catch {
    throw new RefusedError("KEV catalog is not valid JSON");
  }
  const d = doc as { catalogVersion?: unknown; vulnerabilities?: unknown };
  if (typeof d.catalogVersion !== "string" || !Array.isArray(d.vulnerabilities)) throw new RefusedError("KEV catalog has an unexpected shape");
  const cves = new Set<string>();
  for (const v of d.vulnerabilities as { cveID?: unknown }[]) {
    if (typeof v.cveID !== "string") throw new RefusedError("KEV entry without cveID");
    cves.add(v.cveID);
  }
  return { published: d.catalogVersion, cves };
}

function parse(kind: ContextKind, data: Uint8Array): Parsed {
  if (kind === "epss") {
    const e = parseEpss(data);
    return { published: e.published, rows: e.scores.size };
  }
  const k = parseKev(data);
  return { published: k.published, rows: k.cves.size };
}

export function contextRoot(home: string, kind: ContextKind): string {
  return path.join(home, "snapshots", kind);
}

/** Fetch, validate (parse fully before storing), and store an immutable, content-addressed snapshot. */
export async function syncContext(home: string, kind: ContextKind, clock: Clock, fetcher: Fetcher, url = kind === "epss" ? EPSS_URL : KEV_URL): Promise<ContextSnapshot> {
  const data = await fetcher(url);
  const parsed = parse(kind, data);
  const sha256 = hashBytes(data);
  const fetchedAt = clock.nowIso();
  const id = `${fetchedAt.slice(0, 10).replace(/-/g, "")}-${sha256.slice(7, 19)}`;
  const snap: ContextSnapshot = { kind, id, fetched_at: fetchedAt, sha256, published: parsed.published, rows: parsed.rows };
  const final = path.join(contextRoot(home, kind), id);
  if (existsSync(final)) return verifyContext(home, kind, id);
  const staging = path.join(contextRoot(home, kind), `.staging-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  writeFileSync(path.join(staging, FILE[kind]), data);
  writeFileSync(path.join(staging, "snapshot.json"), canonicalJson(snap));
  renameSync(staging, final);
  return snap;
}

export function listContext(home: string, kind: ContextKind): ContextSnapshot[] {
  const root = contextRoot(home, kind);
  if (!existsSync(root)) return [];
  const snaps = readdirSync(root)
    .filter((d) => !d.startsWith(".") && existsSync(path.join(root, d, "snapshot.json")))
    .map((d) => JSON.parse(readFileSync(path.join(root, d, "snapshot.json"), "utf8")) as ContextSnapshot);
  return stableSort(snaps, (s) => [s.fetched_at, s.id]);
}

export function verifyContext(home: string, kind: ContextKind, id: string): ContextSnapshot {
  const dir = path.join(contextRoot(home, kind), id);
  const meta = path.join(dir, "snapshot.json");
  if (!existsSync(meta)) throw new RefusedError(`${kind.toUpperCase()} snapshot ${id} not found (run \`radr db sync\`)`);
  const snap = JSON.parse(readFileSync(meta, "utf8")) as ContextSnapshot;
  const file = path.join(dir, FILE[kind]);
  if (!existsSync(file) || hashBytes(readFileSync(file)) !== snap.sha256) throw new RefusedError(`${kind.toUpperCase()} snapshot ${id} is missing or altered`);
  return snap;
}

export interface PinnedContext {
  readonly epss: { readonly id: string } | null | undefined;
  readonly kev: { readonly id: string } | null | undefined;
}

/** Build the VulnContext for a run from the engagement's pinned snapshots (verified first). */
export function loadVulnContext(home: string, pinned: PinnedContext): { ctx: VulnContext; gaps: string[] } {
  const gaps: string[] = [];
  let scores: Map<string, number> | undefined;
  let kev: Set<string> | undefined;
  if (pinned.epss?.id !== undefined) {
    verifyContext(home, "epss", pinned.epss.id);
    scores = parseEpss(readFileSync(path.join(contextRoot(home, "epss"), pinned.epss.id, FILE.epss))).scores;
  } else {
    gaps.push("no EPSS snapshot pinned: EPSS promotion skipped (run `radr db sync`, then re-scope)");
  }
  if (pinned.kev?.id !== undefined) {
    verifyContext(home, "kev", pinned.kev.id);
    kev = parseKev(readFileSync(path.join(contextRoot(home, "kev"), pinned.kev.id, FILE.kev))).cves;
  } else {
    gaps.push("no KEV snapshot pinned: known-exploited promotion skipped (run `radr db sync`, then re-scope)");
  }
  return {
    ctx: {
      epssBp: (cve) => (scores === undefined ? undefined : (scores.get(cve) ?? null)),
      kev: (cve) => (kev === undefined ? undefined : kev.has(cve)),
    },
    gaps,
  };
}
