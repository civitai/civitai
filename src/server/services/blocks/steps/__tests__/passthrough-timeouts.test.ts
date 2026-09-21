import { describe, expect, it } from 'vitest';

import {
  PASS_THROUGH_TIMED_TYPES,
  PASS_THROUGH_TIMEOUT_MAX_SECONDS,
  declaredTimeoutFor,
  passThroughTimeoutSeconds,
} from '../passthrough-timeouts';
import { PLATFORM_INTERNAL_STEP_TYPES } from '../orchestrator-denylist';

describe('passThroughTimeoutSeconds', () => {
  // The default IS the existing behaviour, and it is the conservative one: a
  // `$type` nobody has shown to be rate-card priced keeps the runtime-priced
  // assumption, where `maxBuzz` genuinely is the Buzz bound.
  it('falls back to maxBuzz for an unlisted type', () => {
    expect(passThroughTimeoutSeconds('imageGen', 250)).toBe(250);
    expect(passThroughTimeoutSeconds('composeMedia', 40)).toBe(40);
    expect(passThroughTimeoutSeconds('somethingNobodyHasSeen', 17)).toBe(17);
  });

  it('grants a listed type its reviewed wall clock', () => {
    expect(passThroughTimeoutSeconds('videoGen', 250)).toBe(900);
  });

  // The submitted `$type` is app-controlled text. The denylist compares it
  // case-insensitively, and two guards over the same untrusted field
  // disagreeing about case is how one of them gets bypassed.
  it('matches the type case-insensitively, as the denylist does', () => {
    for (const spelling of ['videoGen', 'videogen', 'VIDEOGEN', 'VideoGen']) {
      expect(passThroughTimeoutSeconds(spelling, 250)).toBe(900);
    }
  });

  // The table must never SHORTEN a job below what the caller declared: a block
  // that asked for a bigger ceiling still has it as its own bound.
  it('never returns less than the declared maxBuzz', () => {
    expect(passThroughTimeoutSeconds('videoGen', 1200)).toBe(1200);
    for (const maxBuzz of [1, 100, 250, 900, 901, 1800]) {
      expect(passThroughTimeoutSeconds('videoGen', maxBuzz)).toBeGreaterThanOrEqual(maxBuzz);
      expect(passThroughTimeoutSeconds('unlisted', maxBuzz)).toBe(maxBuzz);
    }
  });

  // A bare index into a plain object literal would resolve inherited keys —
  // `toString` is truthy and is not a number, and the lookup would return a
  // FUNCTION. Same control the denylist and the posture map document.
  it('does not resolve inherited object keys as timeouts', () => {
    for (const key of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      expect(passThroughTimeoutSeconds(key, 42)).toBe(42);
    }
  });
});

describe('the table itself', () => {
  it('holds only lower-case keys, so the lookup can find them', () => {
    for (const type of PASS_THROUGH_TIMED_TYPES) {
      expect(type).toBe(type.toLowerCase());
    }
  });

  it('holds only positive integers within the occupancy cap', () => {
    for (const type of PASS_THROUGH_TIMED_TYPES) {
      const seconds = declaredTimeoutFor(type);
      expect(Number.isInteger(seconds)).toBe(true);
      expect(seconds).toBeGreaterThan(0);
      expect(seconds).toBeLessThanOrEqual(PASS_THROUGH_TIMEOUT_MAX_SECONDS);
    }
  });

  // 🔴 A LONGER WALL CLOCK FOR A PLATFORM-INTERNAL TYPE WOULD BE A HOLE IN THE
  // DENYLIST'S DIRECTION OF TRAVEL. The denylist refuses these outright, so an
  // entry here for one of them is either dead or a sign the two guards have
  // drifted — and the table is the newer file, so it is the one that would be
  // wrong. Keyed through the same lower-casing both guards use.
  it('grants no allowance to a platform-internal type', () => {
    const denied = new Set(PLATFORM_INTERNAL_STEP_TYPES.map((t) => t.toLowerCase()));
    for (const type of PASS_THROUGH_TIMED_TYPES) {
      expect(denied.has(type)).toBe(false);
    }
  });

  // The measured basis for the one entry, restated where a reader will see it:
  // ten six-second minimax-h3-comfy clips ran 321.2s to 357.2s. An allowance
  // below the slowest observed run is an allowance that kills a healthy job.
  it('gives videoGen more than the slowest measured clip', () => {
    const SLOWEST_MEASURED_SECONDS = 357.2;
    expect(declaredTimeoutFor('videoGen')).toBeGreaterThan(SLOWEST_MEASURED_SECONDS);
  });
});
