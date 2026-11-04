"use strict";
/**
 * A shifted clock for the session story's test (2026-10-22): shiftDate(ms) makes Date.now() and new Date() run
 * `ms` off the real clock, at the real pace (timers unchanged). Used by the test process and its fake supervisor,
 * and handed to the page through page.clock.setSystemTime, so the story reads the same afternoon at any hour; the
 * scratch server keeps the real clock (a shifted server breaks sign-in cookies and TOTP). The real Date stays on
 * globalThis.__RealDate. Optional: STORY_CLOCK_SHIFT=ms applies it on require. See story-fixture.cjs pinClock.
 */
function shiftDate(shift) {
  const Real = globalThis.__RealDate || Date;
  class Shifted extends Real {
    constructor(...a) { if (a.length) super(...a); else super(Real.now() + shift); }
    static now() { return Real.now() + shift; }
  }
  globalThis.__RealDate = Real;
  globalThis.Date = Shifted;
  return shift;
}
if (process.env.STORY_CLOCK_SHIFT && Number(process.env.STORY_CLOCK_SHIFT)) shiftDate(Number(process.env.STORY_CLOCK_SHIFT));
module.exports = { shiftDate };
