import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixedClock } from "../../src/core/clock.js";
import { hash } from "../../src/core/determinism.js";
import { RefusedError } from "../../src/core/errors.js";
import { run } from "../../src/core/exec.js";
import { EventLog, acquireLock, fold, parseLog } from "../../src/state/events.js";
import { tmpDir } from "../helpers/tmp.js";

const fp = (n: number) => hash(["fp", n]);
const clock = () => fixedClock("2026-10-07T14:00:00Z", 1000);

function seededLog(n = 3): { log: EventLog; file: string } {
  const file = path.join(tmpDir(), "events.jsonl");
  const log = new EventLog(file, clock());
  for (let i = 0; i < n; i++) log.append("scope-proposed", "sean@example.com", { fingerprint: fp(i), engagement_hash: fp(100 + i) });
  return { log, file };
}

const lines = (file: string) => readFileSync(file, "utf8").slice(0, -1).split("\n");
const rewrite = (file: string, ls: string[]) => { writeFileSync(file, ls.map((l) => `${l}\n`).join("")); };

describe("EventLog", () => {
  it("appends a hash chain and reads it back", () => {
    const { log } = seededLog(3);
    const events = log.read();
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]);
    const [first, second, third] = events;
    assert.ok(first && second && third);
    assert.equal(first.prev, "genesis");
    assert.equal(second.prev, first.hash);
    assert.equal(third.at, "2026-10-07T14:00:02.000Z");
  });

  it("reads a missing log as empty", () => {
    assert.deepEqual(new EventLog(path.join(tmpDir(), "none.jsonl"), clock()).read(), []);
  });

  it("is deterministic: same inputs and clock give byte-identical logs", () => {
    const a = seededLog(3).file;
    const b = seededLog(3).file;
    assert.equal(readFileSync(a, "utf8"), readFileSync(b, "utf8"));
  });

  const corruptions: [string, (ls: string[]) => string[], RegExp][] = [
    ["edited payload", (ls) => ls.map((l, i) => (i === 1 ? l.replace(fp(1), fp(99)) : l)), /hash mismatch/],
    ["deleted middle record", (ls) => [ls[0] ?? "", ls[2] ?? ""], /seq 3, expected 2/],
    ["reordered records", (ls) => [ls[1] ?? "", ls[0] ?? "", ls[2] ?? ""], /seq 2, expected 1/],
    ["non-JSON line", (ls) => [...ls.slice(0, 2), "{oops"], /not valid JSON/],
    ["unknown event type", (ls) => ls.map((l, i) => (i === 2 ? l.replace('"scope-proposed"', '"made-up"') : l)), /type/],
    ["extra field", (ls) => ls.map((l, i) => (i === 0 ? l.replace('{"actor"', '{"extra":1,"actor"') : l)), /additionalProperties|extra/],
  ];
  for (const [name, mutate, message] of corruptions) {
    it(`refuses a log with a ${name}`, () => {
      const { log, file } = seededLog(3);
      rewrite(file, mutate(lines(file)));
      assert.throws(() => log.read(), (e: unknown) => e instanceof RefusedError && message.test(e.message));
    });
  }

  it("refuses a log whose last record is truncated", () => {
    const { log, file } = seededLog(2);
    writeFileSync(file, readFileSync(file, "utf8").slice(0, -10));
    assert.throws(() => log.read(), /truncated/);
  });

  it("refuses to append to a corrupt log", () => {
    const { log, file } = seededLog(2);
    rewrite(file, lines(file).map((l) => l.replace("sean@", "eve@")));
    assert.throws(() => log.append("scope-proposed", "x", { fingerprint: fp(9), engagement_hash: fp(9) }), RefusedError);
  });

  it("rejects an invalid payload before writing anything", () => {
    const { log, file } = seededLog(1);
    const before = readFileSync(file, "utf8");
    assert.throws(() => log.append("scope-approved", "x", { fingerprint: "not-a-hash", sha: "abc" }), RefusedError);
    assert.throws(() => log.append("scope-proposed", "x", { fingerprint: fp(1), engagement_hash: fp(1), oops: 1.5 }), RefusedError);
    assert.equal(readFileSync(file, "utf8"), before);
  });

  it("serializes concurrent appends from separate processes into one valid chain", async () => {
    const file = path.join(tmpDir(), "events.jsonl");
    const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), "../helpers/append-many.js");
    const writers = ["a", "b", "c", "d"];
    const results = await Promise.all(writers.map((tag) => run({ command: process.execPath, args: [helper, file, "15", tag], cwd: process.cwd() })));
    for (const r of results) assert.equal(r.outcome, "ok", r.stderr.toString());
    const events = parseLog(readFileSync(file, "utf8"), file);
    assert.equal(events.length, 60);
    for (const tag of writers) assert.equal(events.filter((e) => e.actor === `writer-${tag}`).length, 15);
  });
});

describe("acquireLock", () => {
  it("reclaims a lock held by a dead process", () => {
    const lock = path.join(tmpDir(), "events.jsonl.lock");
    writeFileSync(lock, "999999"); // no such pid (beyond default pid_max on macOS/Linux)
    acquireLock(lock, 50);
    assert.equal(readFileSync(lock, "utf8"), String(process.pid));
  });

  it("waits, then refuses, when a live process holds the lock", () => {
    const lock = path.join(tmpDir(), "events.jsonl.lock");
    writeFileSync(lock, String(process.ppid)); // parent process: alive for the duration of the test
    assert.throws(() => { acquireLock(lock, 60); }, /locked by running process/);
  });

  it("only reclaims an unreadable lock after the full wait", () => {
    const lock = path.join(tmpDir(), "events.jsonl.lock");
    writeFileSync(lock, "");
    acquireLock(lock, 40);
    assert.equal(readFileSync(lock, "utf8"), String(process.pid));
  });
});

describe("fold", () => {
  it("derives state from events in order", () => {
    const { log } = seededLog(3);
    const lastFp = fold(log.read(), "", (_s, e) => String(e.data["fingerprint"]));
    assert.equal(lastFp, fp(2));
  });
});
