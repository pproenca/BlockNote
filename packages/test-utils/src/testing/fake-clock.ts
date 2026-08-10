export interface BlockNoteTestClock {
  now(): Date;
  advance(milliseconds: number): void;
}

export function createBlockNoteTestClock(
  initial = new Date("2026-01-01T00:00:00.000Z"),
): BlockNoteTestClock {
  let time = initial.getTime();
  return Object.freeze({
    now: () => new Date(time),
    advance(milliseconds: number) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        throw new RangeError(
          "Clock advancement must be a non-negative number.",
        );
      }
      time += milliseconds;
    },
  });
}
