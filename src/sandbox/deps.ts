// `radr deps warm` (M2 AC8): populate a dependency cache ONLINE in the sandbox, then freeze it
// as a content-addressed snapshot so sandboxed lanes can install OFFLINE (--network=none).
//
//   $RADR_HOME/snapshots/deps/<engagement>/<id>/{cache/, snapshot.json}
//
// The id is derived from a deterministic tree hash (sorted paths + file hashes). Package-manager
// caches contain timestamps, so two warms may differ: each is its own snapshot, pinned per scope.

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Clock } from "../core/clock.js";
import { canonicalJson, compareCodePoints, hash, hashBytes, stableSort } from "../core/determinism.js";
import { RefusedError } from "../core/errors.js";
import type { EngagementDoc } from "../engagement/config.js";
import type { Layout } from "../engagement/home.js";
import { CACHE_MOUNT, nodeInstall, pythonInstall } from "./recipe.js";
import { imageRef, runSandbox, type Runtime } from "./runtime.js";
import { ensureStackImage } from "./stack-images.js";
import { drivers } from "./stacks.js";

export interface DepsSnapshot {
  readonly id: string;
  readonly engagement: string;
  readonly fetched_at: string;
  readonly tree_hash: string;
  readonly files: number;
  readonly stacks: readonly string[];
}

/** Deterministic hash of a directory tree. Symlinks are hashed by target, never followed. */
export function treeHash(root: string): { hash: string; files: number } {
  const entries: [string, string][] = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of [...readdirSync(dir)].sort(compareCodePoints)) {
      const abs = path.join(dir, name);
      const r = rel === "" ? name : `${rel}/${name}`;
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) entries.push([r, `link:${readlinkSync(abs)}`]);
      else if (st.isDirectory()) walk(abs, r);
      else if (st.isFile()) entries.push([r, hashBytes(readFileSync(abs))]);
    }
  };
  if (existsSync(root)) walk(root, "");
  return { hash: hash(entries), files: entries.length };
}

export function depsRoot(home: string, engagement: string): string {
  return path.join(home, "snapshots", "deps", engagement);
}

const WARM_TIMEOUT_MS = 30 * 60 * 1000;

export async function warmDeps(home: string, l: Layout, doc: EngagementDoc, rt: Runtime, clock: Clock, log: (line: string) => void = () => undefined): Promise<DepsSnapshot> {
  const build = doc.build;
  if (build === undefined || Object.keys(build).length === 0) throw new RefusedError("engagement.yml has no build recipe to warm (run `radr scope`)");
  const root = depsRoot(home, l.id);
  const staging = path.join(root, `.staging-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  const cache = path.join(staging, "cache");
  mkdirSync(cache, { recursive: true });
  const stacks: string[] = [];

  const warm = async (stack: string, image: string, dir: string, command: string, env: Readonly<Record<string, string>> = {}): Promise<void> => {
    const out = path.join(staging, "out", stack);
    mkdirSync(out, { recursive: true });
    const r = await runSandbox({
      runtime: rt, image: image.includes("@") || image.startsWith("localhost/") ? image : imageRef(image), name: `radr-${l.id}-warm-${stack.replace(/[^a-z0-9]/g, "")}`.slice(0, 120), network: true, env,
      mounts: [{ host: l.worktree, container: "/src", readOnly: true }, { host: cache, container: CACHE_MOUNT, readOnly: false }, { host: out, container: "/radr/out", readOnly: false }],
      workdir: dir, steps: [{ name: "warm", command, required: true }], timeoutMs: WARM_TIMEOUT_MS,
    }, out);
    const step = r.steps.find((s) => s.name === "warm");
    if (r.exec.outcome !== "ok" || step?.exitCode !== 0) {
      const log = existsSync(path.join(out, "warm.log")) ? readFileSync(path.join(out, "warm.log"), "utf8").trim().split("\n").slice(-5).join(" | ") : r.exec.stderr.toString().trim();
      rmSync(staging, { recursive: true, force: true });
      throw new RefusedError(`deps warm failed for ${stack}: ${log}`);
    }
    stacks.push(stack);
  };

  const node = build["typescript-javascript"];
  if (node !== undefined) await warm("typescript-javascript", "node", node.dir, nodeInstall("warm"));
  const py = build.python;
  if (py !== undefined) await warm("python", "python", py.dir, pythonInstall(py, "warm"));
  // M3 W5 stacks: build/pull the stack image (this is the online step), then warm its cache.
  for (const { driver, recipe, dotnetSdk } of drivers(build, doc.stacks, true)) {
    const image = await ensureStackImage(home, rt, driver.stack, log, dotnetSdk);
    await warm(driver.stack, image, recipe.dir, driver.install("warm"), driver.env("warm"));
  }

  rmSync(path.join(staging, "out"), { recursive: true, force: true });
  const tree = treeHash(cache);
  const fetchedAt = clock.nowIso();
  const id = `${fetchedAt.slice(0, 10).replace(/-/g, "")}-${tree.hash.slice(7, 19)}`;
  const snap: DepsSnapshot = { id, engagement: l.id, fetched_at: fetchedAt, tree_hash: tree.hash, files: tree.files, stacks: stableSort(stacks, (s) => s) };
  writeFileSync(path.join(staging, "snapshot.json"), canonicalJson(snap));
  const final = path.join(root, id);
  if (existsSync(final)) {
    rmSync(staging, { recursive: true, force: true });
  } else {
    renameSync(staging, final);
  }
  return snap;
}

export function listDeps(home: string, engagement: string): DepsSnapshot[] {
  const root = depsRoot(home, engagement);
  if (!existsSync(root)) return [];
  const snaps = readdirSync(root)
    .filter((d) => !d.startsWith(".") && existsSync(path.join(root, d, "snapshot.json")))
    .map((d) => JSON.parse(readFileSync(path.join(root, d, "snapshot.json"), "utf8")) as DepsSnapshot);
  return stableSort(snaps, (s) => [s.fetched_at, s.id]);
}

/** Re-hash the cache tree; refuses if anything changed since the warm. Returns the cache dir. */
export function verifyDeps(home: string, engagement: string, id: string): string {
  const dir = path.join(depsRoot(home, engagement), id);
  const meta = path.join(dir, "snapshot.json");
  if (!existsSync(meta)) throw new RefusedError(`dependency snapshot ${id} not found (run \`radr deps warm\`)`);
  const snap = JSON.parse(readFileSync(meta, "utf8")) as DepsSnapshot;
  if (treeHash(path.join(dir, "cache")).hash !== snap.tree_hash) throw new RefusedError(`dependency snapshot ${id} was altered after warming`);
  return path.join(dir, "cache");
}
