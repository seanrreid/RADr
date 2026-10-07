// `radr init <client> <slug>` (T2.1): create the engagement folder, its per-engagement salt,
// and the first event.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { Clock } from "../core/clock.js";
import { hashBytes } from "../core/determinism.js";
import { RefusedError, UsageError } from "../core/errors.js";
import { SLUG } from "../schemas/validate.js";
import { EventLog } from "../state/events.js";
import { layout, type Layout } from "./home.js";

const SALT_BYTES = 32;

export function initEngagement(home: string, client: string, slug: string, actor: string, clock: Clock): Layout {
  for (const [name, v] of [["client", client], ["slug", slug]] as const) {
    if (!new RegExp(SLUG).test(v)) throw new UsageError(`invalid ${name} "${v}" (lowercase letters, digits, hyphens)`);
  }
  const l = layout(home, `${client}-${slug}`);
  if (existsSync(l.dir)) throw new RefusedError(`engagement ${l.id} already exists at ${l.dir}`);

  for (const d of [l.dir, l.raw, l.cache, l.artifacts]) mkdirSync(d, { recursive: true, mode: 0o700 });
  // The salt keys secret-match hashes so they can't be correlated across engagements or
  // brute-forced from a short dictionary. It never leaves the engagement folder.
  const salt = randomBytes(SALT_BYTES).toString("hex");
  writeFileSync(l.salt, salt, { mode: 0o600 });

  new EventLog(l.events, clock).append("engagement-created", actor, { client, slug, salt_hash: hashBytes(salt) });
  return l;
}
