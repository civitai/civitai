import { describe, expect, it } from 'vitest';
import { flagGap, flagLeader } from '~/components/HatTurf/FlagRace/flag-race.utils';

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
