import { describe, expect, it } from 'vitest';
import {
  RING_LENGTH,
  badgeLeader,
  orderedTeams,
  ringArcs,
  standingsLabel,
  viewerBehind,
} from '~/components/HatTurf/hat-turf.utils';

const counted = { blue: 6, pink: 4, green: 2, yellow: 1 };

describe('ringArcs', () => {
  it('sizes each arc by its share and leaves a gap between neighbours', () => {
    const arcs = ringArcs(counted);
    const total = 13;
    arcs.forEach((arc) => {
      const share = counted[arc.team as keyof typeof counted] / total;
      expect(arc.length).toBeCloseTo(share * RING_LENGTH - 2.2, 5);
    });
  });

  it('starts each arc where the previous share ended', () => {
    // Alphabetical: blue 6, green 2, pink 4, yellow 1.
    const [blue, green, pink, yellow] = ringArcs(counted);
    expect([blue.team, green.team, pink.team, yellow.team]).toEqual([
      'blue',
      'green',
      'pink',
      'yellow',
    ]);
    expect(blue.offset).toBe(0);
    expect(green.offset).toBeCloseTo((6 / 13) * RING_LENGTH, 5);
    expect(pink.offset).toBeCloseTo(((6 + 2) / 13) * RING_LENGTH, 5);
    expect(yellow.offset).toBeCloseTo(((6 + 2 + 4) / 13) * RING_LENGTH, 5);
  });

  it('keeps teams in a fixed order so an arc keeps its place when the lead changes', () => {
    expect(orderedTeams({ pink: 9, blue: 1 })).toEqual(['blue', 'pink']);
    expect(ringArcs({ pink: 9, blue: 1 }).map((a) => a.team)).toEqual(['blue', 'pink']);
  });

  it('draws nothing, and no gap, when there are no hats', () => {
    expect(ringArcs({ blue: 0, pink: 0 }).every((a) => a.length === 0)).toBe(true);
  });

  it('one team alone closes the whole ring with no gap', () => {
    const [blue, pink] = ringArcs({ blue: 3, pink: 0 });
    expect(blue.length).toBeCloseTo(RING_LENGTH, 5);
    expect(pink.length).toBe(0);
  });
});

describe('badgeLeader', () => {
  it('is the server leader when that team has counted hats', () => {
    expect(badgeLeader({ counted, leader: 'blue' })).toBe('blue');
  });
  it('is null with no leader, or a leader with nothing counted (shown-only stickers)', () => {
    expect(badgeLeader({ counted, leader: null })).toBeNull();
    expect(badgeLeader({ counted: { blue: 0 }, leader: 'blue' })).toBeNull();
  });
});

describe('viewerBehind', () => {
  it('shows the viewer’s team count when it is not the leader', () => {
    expect(viewerBehind({ counted, leader: 'blue' }, 'pink')).toEqual({ team: 'pink', count: 4 });
  });
  it('is null for the leader, for no team, and when nobody leads', () => {
    expect(viewerBehind({ counted, leader: 'blue' }, 'blue')).toBeNull();
    expect(viewerBehind({ counted, leader: 'blue' }, null)).toBeNull();
    expect(viewerBehind({ counted: {}, leader: null }, 'pink')).toBeNull();
  });
  it('a team with no hats yet reads 0', () => {
    expect(viewerBehind({ counted: { blue: 2 }, leader: 'blue' }, 'green')).toEqual({
      team: 'green',
      count: 0,
    });
  });
});

describe('standingsLabel', () => {
  it('names the leader, every count and the viewer’s team', () => {
    expect(standingsLabel({ counted, leader: 'blue' }, 'pink')).toBe(
      'Hat Turf: blue leads with 6. blue 6, green 2, pink 4, yellow 1. You are on pink.'
    );
  });
  it('says there are no hats yet', () => {
    expect(standingsLabel({ counted: {}, leader: null }, 'pink')).toBe('Hat Turf: no hats yet');
  });
});
