// The append-only, hash-chained event log: the authority for every gate and disposition
// (PRD P3, M1 AC5). Each event commits to its predecessor's hash, so an edited, reordered,
// deleted, or truncated record breaks the chain and the log is refused.

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import type { Clock } from "../core/clock.js";
import { canonicalJson, hash } from "../core/determinism.js";
import { RefusedError } from "../core/errors.js";
import { GENESIS, validateEvent, validatePayload, type EventEnvelope, type EventType } from "../schemas/events.js";

export type Event = EventEnvelope;

/** The fields an event's hash commits to: everything except the hash itself. */
function eventHash(e: Omit<EventEnvelope, "hash">): string {
  return hash({ v: e.v, seq: e.seq, type: e.type, at: e.at, actor: e.actor, data: e.data, prev: e.prev });
}

/** Parse and verify a whole log. Throws RefusedError on any corruption. */
export function parseLog(text: string, where: string): Event[] {
  if (text === "") return [];
  if (!text.endsWith("\n")) throw new RefusedError(`${where}: last record is truncated (no trailing newline)`);
  const lines = text.slice(0, -1).split("\n");
  const events: Event[] = [];
  let prev = GENESIS;
  lines.forEach((line, i) => {
    const at = `${where}:${i + 1}`;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new RefusedError(`${at}: not valid JSON`);
    }
    const e = validateEvent(raw, at);
    if (e.seq !== i + 1) throw new RefusedError(`${at}: seq ${e.seq}, expected ${i + 1}`);
    if (e.prev !== prev) throw new RefusedError(`${at}: chain broken (prev does not match previous event hash)`);
    if (eventHash(e) !== e.hash) throw new RefusedError(`${at}: hash mismatch (record was modified)`);
    if (canonicalJson(e) !== line) throw new RefusedError(`${at}: record is not in canonical form`);
    events.push(e);
    prev = e.hash;
  });
  return events;
}

export class EventLog {
  constructor(
    readonly file: string,
    private readonly clock: Clock,
  ) {}

  read(): Event[] {
    return existsSync(this.file) ? parseLog(readFileSync(this.file, "utf8"), this.file) : [];
  }

  /** Verify the full chain, then append one event durably (fsync) under an exclusive lock. */
  append(type: EventType, actor: string, data: Record<string, unknown>): Event {
    validatePayload(type, data, `${this.file} (new event)`);
    return this.withLock(() => {
      const existing = this.read();
      const last = existing.at(-1);
      const unsigned = { v: 1 as const, seq: existing.length + 1, type, at: this.clock.nowIso(), actor, data, prev: last?.hash ?? GENESIS };
      const event: Event = { ...unsigned, hash: eventHash(unsigned) };
      const fd = openSync(this.file, "a");
      try {
        writeSync(fd, `${canonicalJson(event)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return event;
    });
  }

  private withLock<T>(fn: () => T): T {
    const lock = `${this.file}.lock`;
    acquireLock(lock);
    try {
      return fn();
    } finally {
      unlinkSync(lock);
    }
  }
}

const LOCK_WAIT_MS = 5000;
const LOCK_POLL_MS = 20;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/** Exclusive create of `lock`. Waits up to LOCK_WAIT_MS for a live holder; reclaims dead ones. */
export function acquireLock(lock: string, waitMs = LOCK_WAIT_MS): void {
  let waited = 0;
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const holder = readHolder(lock);
    // A dead holder is stale: reclaim now. An unreadable lock may be mid-write by a live
    // holder, so it is only reclaimed after the full wait.
    const stale = holder === undefined ? waited >= waitMs : holder !== process.pid && !isAlive(holder);
    if (stale) {
      try {
        unlinkSync(lock);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      waited = 0;
      continue;
    }
    if (waited >= waitMs) throw new RefusedError(`event log is locked by running process ${String(holder)} (${lock})`);
    Atomics.wait(sleepCell, 0, 0, LOCK_POLL_MS);
    waited += LOCK_POLL_MS;
  }
}

function readHolder(lock: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(lock, "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Left fold over events: the only way state is derived from the log. */
export function fold<S>(events: readonly Event[], init: S, reducer: (state: S, event: Event) => S): S {
  return events.reduce(reducer, init);
}
