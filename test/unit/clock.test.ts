import { it } from "node:test";
import assert from "node:assert/strict";
import { fixedClock } from "../../src/core/clock.js";

it("fixedClock is frozen by default and steps when asked", () => {
  const frozen = fixedClock("2026-10-07T14:02:00Z");
  assert.equal(frozen.nowIso(), "2026-10-07T14:02:00.000Z");
  assert.equal(frozen.nowIso(), "2026-10-07T14:02:00.000Z");
  const stepping = fixedClock("2026-10-07T14:02:00Z", 1000);
  stepping.nowIso();
  assert.equal(stepping.nowIso(), "2026-10-07T14:02:01.000Z");
});

it("fixedClock rejects invalid timestamps", () => {
  assert.throws(() => fixedClock("not-a-date"));
});
