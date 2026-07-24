import { describe, expect, it } from 'vitest';
import { isPaidAccessActive, isTimedWindowOver, paidAccessMode } from '@civitai/buzz';

const NOW = new Date('2026-07-23T12:00:00Z');
const FUTURE = new Date('2026-08-01T00:00:00Z');
const PAST = new Date('2026-07-01T00:00:00Z');

describe('paidAccessMode', () => {
  it.each([
    // Permanent is the case every ad-hoc derivation got wrong: no end date at all.
    [{ earlyAccessEndsAt: null, permanent: true }, 'permanent'],
    // ...and it stays permanent even alongside a stale/elapsed end date.
    [{ earlyAccessEndsAt: PAST, permanent: true }, 'permanent'],
    [{ earlyAccessEndsAt: FUTURE, permanent: false }, 'timed'],
    [{ earlyAccessEndsAt: PAST, permanent: false }, 'none'],
    [{ earlyAccessEndsAt: null, permanent: false }, 'none'],
    [{}, 'none'],
  ])('%o -> %s', (input, expected) => {
    expect(paidAccessMode(input, NOW)).toBe(expected);
  });

  it('accepts ISO strings as well as Dates', () => {
    expect(paidAccessMode({ earlyAccessEndsAt: FUTURE.toISOString() }, NOW)).toBe('timed');
  });
});

describe('isPaidAccessActive', () => {
  it('is true for permanent even with no end date', () => {
    expect(isPaidAccessActive({ earlyAccessEndsAt: null, permanent: true }, NOW)).toBe(true);
  });

  it('is false once a timed window elapses', () => {
    expect(isPaidAccessActive({ earlyAccessEndsAt: PAST }, NOW)).toBe(false);
  });
});

describe('isTimedWindowOver', () => {
  // The regression this guards: permanent has no window, so treating "no end date" as "over" disabled every
  // permanent control after publishing.
  it('is never true for permanent access', () => {
    expect(isTimedWindowOver({ earlyAccessEndsAt: null, permanent: true }, NOW)).toBe(false);
    expect(isTimedWindowOver({ earlyAccessEndsAt: PAST, permanent: true }, NOW)).toBe(false);
  });

  it('is true for an elapsed or absent window', () => {
    expect(isTimedWindowOver({ earlyAccessEndsAt: PAST }, NOW)).toBe(true);
    expect(isTimedWindowOver({ earlyAccessEndsAt: null }, NOW)).toBe(true);
  });

  it('is false while a window is still running', () => {
    expect(isTimedWindowOver({ earlyAccessEndsAt: FUTURE }, NOW)).toBe(false);
  });
});
