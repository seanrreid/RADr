// The only module allowed to read wall-clock time. Everything else receives a Clock,
// so tests and replays are reproducible and timestamps never leak into hashed content.

export interface Clock {
  /** ISO-8601 UTC timestamp, e.g. 2026-10-07T14:02:00.000Z */
  nowIso(): string;
}

export const systemClock: Clock = {
  nowIso: () => new Date().toISOString(),
};

/** A clock frozen at `iso`, advancing by `stepMs` on each read (0 = frozen). */
export function fixedClock(iso: string, stepMs = 0): Clock {
  let t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`fixedClock: invalid ISO timestamp ${iso}`);
  return {
    nowIso: () => {
      const out = new Date(t).toISOString();
      t += stepMs;
      return out;
    },
  };
}
