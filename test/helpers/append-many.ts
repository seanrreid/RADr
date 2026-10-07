// Subprocess helper: append N events to a log. Used to test cross-process locking.
import { systemClock } from "../../src/core/clock.js";
import { hash } from "../../src/core/determinism.js";
import { EventLog } from "../../src/state/events.js";

const [file, countArg, tag] = process.argv.slice(2);
if (file === undefined || countArg === undefined || tag === undefined) throw new Error("usage: append-many <file> <n> <tag>");
const log = new EventLog(file, systemClock);
for (let i = 0; i < Number(countArg); i++) {
  log.append("scope-proposed", `writer-${tag}`, { fingerprint: hash([tag, i]), engagement_hash: hash(tag) });
}
