/** Hat Turf on feed cards: the pure parts (ring arcs, leader, what the badge says). */

/** The standings of one image: hats that count per team (the number that decides the lead). */
export type TurfCounted = Record<string, number>;

export type TurfSummary = {
  shown: TurfCounted;
  counted: TurfCounted;
  leader: string | null;
  leaderCosmeticId: number | null;
  hatted: boolean;
};

/** Radius of the ring's circle in the badge's 44-unit box; the arcs are drawn on it. */
export const RING_RADIUS = 20;
export const RING_LENGTH = 2 * Math.PI * RING_RADIUS;
/** Visible gap between two arcs, in ring units, so neighbours do not read as one. */
const ARC_GAP = 2.2;

/** Teams in a fixed order, so an arc keeps its place on the ring when the lead changes. */
export const orderedTeams = (counted: TurfCounted) => Object.keys(counted).sort();

export type RingArc = { team: string; length: number; offset: number };

/**
 * One arc per team, its length its share of the hats that count. A team with none gets a zero-length
 * arc (kept, so it can grow in place). No hats at all gives no length anywhere.
 */
export function ringArcs(counted: TurfCounted): RingArc[] {
  const teams = orderedTeams(counted);
  const total = teams.reduce((sum, team) => sum + Math.max(0, counted[team] ?? 0), 0);
  const drawn = teams.filter((team) => (counted[team] ?? 0) > 0).length;
  const gap = drawn > 1 ? ARC_GAP : 0;
  let start = 0;
  return teams.map((team) => {
    const share = total ? Math.max(0, counted[team] ?? 0) / total : 0;
    const arc = { team, length: total ? Math.max(0, share * RING_LENGTH - gap) : 0, offset: start };
    start += share * RING_LENGTH;
    return arc;
  });
}

/**
 * The team the badge shows: the one with the most counted hats; a tie goes to the server's `leader`
 * (the team that got there first), so the badge never disagrees with who earns.
 */
export function badgeLeader(summary: Pick<TurfSummary, 'counted' | 'leader'>): string | null {
  const { counted, leader } = summary;
  if (leader && (counted[leader] ?? 0) > 0) return leader;
  return null;
}

/** The viewer's standing when their team is not the leader; null when they lead or are not on a team. */
export function viewerBehind(
  summary: Pick<TurfSummary, 'counted' | 'leader'>,
  viewerTeam: string | null | undefined
): { team: string; count: number } | null {
  const lead = badgeLeader(summary);
  if (!lead || !viewerTeam || viewerTeam === lead) return null;
  return { team: viewerTeam, count: summary.counted[viewerTeam] ?? 0 };
}

/** The spoken form of the badge: who leads, every team's count, and where the viewer stands. */
export function standingsLabel(
  summary: Pick<TurfSummary, 'counted' | 'leader'>,
  viewerTeam: string | null | undefined
) {
  const lead = badgeLeader(summary);
  if (!lead) return 'Hat Turf: no hats yet';
  const rows = orderedTeams(summary.counted).map((t) => `${t} ${summary.counted[t]}`);
  return `Hat Turf: ${lead} leads with ${summary.counted[lead]}. ${rows.join(', ')}.${
    viewerTeam ? ` You are on ${viewerTeam}.` : ''
  }`;
}
