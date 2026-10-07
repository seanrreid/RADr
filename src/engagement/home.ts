// RADR_HOME layout and engagement resolution.
//   $RADR_HOME (default ~/radr)
//   ├── engagements/<client>-<slug>/   one folder per engagement (PRD §8)
//   ├── tools/                         host-mode toolchain (Wave 3)
//   └── snapshots/                     vuln DB snapshots (Wave 3)

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { UsageError } from "../core/errors.js";

const ENGAGEMENT_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function radrHome(env: NodeJS.ProcessEnv): string {
  const configured = env["RADR_HOME"];
  return path.resolve(configured !== undefined && configured !== "" ? configured : path.join(homedir(), "radr"));
}

export interface Layout {
  readonly id: string;
  readonly dir: string;
  readonly engagementYml: string;
  readonly events: string;
  readonly salt: string;
  readonly toolchainLock: string;
  readonly snapshotsLock: string;
  readonly mirror: string;
  readonly worktree: string;
  readonly raw: string;
  readonly cache: string;
  readonly findings: string;
  readonly artifacts: string;
}

export function layout(home: string, id: string): Layout {
  if (!ENGAGEMENT_ID.test(id)) throw new UsageError(`invalid engagement id "${id}" (expected <client>-<slug>, lowercase)`);
  const dir = path.join(home, "engagements", id);
  return {
    id,
    dir,
    engagementYml: path.join(dir, "engagement.yml"),
    events: path.join(dir, "events.jsonl"),
    salt: path.join(dir, "salt"),
    toolchainLock: path.join(dir, "toolchain.lock"),
    snapshotsLock: path.join(dir, "snapshots.lock"),
    mirror: path.join(dir, "source", "mirror.git"),
    worktree: path.join(dir, "source", "worktree"),
    raw: path.join(dir, "raw"),
    cache: path.join(dir, "cache"),
    findings: path.join(dir, "findings.jsonl"),
    artifacts: path.join(dir, "artifacts"),
  };
}

/**
 * Which engagement a command acts on: --engagement, else $RADR_ENGAGEMENT, else the engagement
 * folder containing the current directory.
 */
export function resolveEngagement(home: string, flag: string | undefined, env: NodeJS.ProcessEnv, cwd: string): Layout {
  const fromEnv = env["RADR_ENGAGEMENT"];
  const id = flag ?? (fromEnv !== undefined && fromEnv !== "" ? fromEnv : idFromCwd(home, cwd));
  if (id === undefined) throw new UsageError("no engagement selected: pass --engagement <id>, set RADR_ENGAGEMENT, or run inside an engagement folder");
  const l = layout(home, id);
  if (!existsSync(l.events)) throw new UsageError(`engagement "${id}" not found under ${path.join(home, "engagements")} (run \`radr init\`)`);
  return l;
}

function idFromCwd(home: string, cwd: string): string | undefined {
  const rel = path.relative(path.join(home, "engagements"), path.resolve(cwd));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep)[0];
}
