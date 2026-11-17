import { describe, expect, it } from 'vitest';
import {
  flagClock,
  flagCounting,
  flagGap,
  flagHatChoices,
  flagLeader,
} from '~/components/HatTurf/FlagRace/flag-race.utils';

describe('the flag badge figures', () => {
  it('names the one team with the most hats, and nobody when tied or empty', () => {
    expect(flagLeader({ Blue: 5, Pink: 3 })).toBe('Blue');
    expect(flagLeader({ Blue: 5, Pink: 5 })).toBeNull();
    expect(flagLeader({ Blue: 0, Pink: 0 })).toBeNull();
  });

  it("shows the viewer's team ahead of the next team when it holds the flag, else behind the leader", () => {
    const hats = { Blue: 140, Pink: 180, Green: 60 };
    expect(flagGap(hats, 'Blue')).toBe(-40);
    expect(flagGap(hats, 'Pink')).toBe(40);
    expect(flagGap({ Blue: 50, Pink: 50 }, 'Blue')).toBe(0);
    // A team with no hats yet is behind by the whole lead.
    expect(flagGap({ Pink: 7 }, 'Blue')).toBe(-7);
  });

  it('has no gap for a viewer without a team, or on a flag nobody has hatted', () => {
    expect(flagGap({ Blue: 3 }, null)).toBeNull();
    expect(flagGap({ Blue: 0 }, 'Blue')).toBeNull();
  });
});

describe('the flag hat picker', () => {
  it('offers 1, 5 and 10, each capped at the hats the player has, never twice', () => {
    expect(flagHatChoices(20)).toEqual([1, 5, 10]);
    expect(flagHatChoices(8)).toEqual([1, 5, 8]);
    expect(flagHatChoices(5)).toEqual([1, 5]);
    expect(flagHatChoices(4)).toEqual([1, 4]);
    expect(flagHatChoices(1)).toEqual([1]);
    // Stock refills fractionally: 7.6 hats is 7 to spend.
    expect(flagHatChoices(7.6)).toEqual([1, 5, 7]);
    expect(flagHatChoices(0)).toEqual([]);
    expect(flagHatChoices(0.4)).toEqual([]);
  });
});

describe('counting results between the cut and the freeze', () => {
  it('counts only once cut and not yet frozen', () => {
    expect(flagCounting({ closed: true, frozen: false })).toBe(true);
    expect(flagCounting({ closed: true, frozen: true })).toBe(false);
    expect(flagCounting({ closed: false, frozen: false })).toBe(false);
  });
  it('reads a summary cached before the field existed as frozen', () => {
    expect(flagCounting({ closed: true })).toBe(false);
  });
});

describe('the race clock', () => {
  const closesAt = '2026-11-16T22:00:00Z';
  const at = (iso: string) => new Date(iso).getTime();
  it('counts to the start of the final hour, never to the secret cut', () => {
    expect(flagClock(at('2026-11-16T18:45:55Z'), closesAt, false)).toEqual({
      phase: 'counting',
      secondsLeft: 2 * 3600 + 14 * 60 + 5,
    });
  });
  it('says any moment through the final hour, and past closesAt until the summary closes', () => {
    expect(flagClock(at('2026-11-16T21:00:00Z'), closesAt, false).phase).toBe('final');
    expect(flagClock(at('2026-11-16T22:05:00Z'), closesAt, false).phase).toBe('final');
  });
  it('stops once the day is closed', () => {
    expect(flagClock(at('2026-11-16T18:00:00Z'), closesAt, true).phase).toBe('closed');
  });
});
