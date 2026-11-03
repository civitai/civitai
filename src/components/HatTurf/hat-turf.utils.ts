/** Hat Turf on feed cards: the pure parts (ring arcs, leader, what the badge says). */

import { SignalTopic } from '~/server/common/enums';
import {
  STICKER_PLACEMENT_MAX_SCALE,
  STICKER_PLACEMENT_MIN_SCALE,
} from '~/shared/utils/sticker-placement';

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

/** A placed hat's width as a fraction of the drawn image (the sticker system's own default). */
export const HAT_DEFAULT_SCALE = 0.22;

/** Keeps a dragged hat's centre on the picture, a little inside the edge so the whole hat shows. */
export function clampSpot(spot: { x: number; y: number }) {
  const clamp = (n: number) => Math.min(0.92, Math.max(0.08, Number.isFinite(n) ? n : 0.5));
  return { x: clamp(spot.x), y: clamp(spot.y) };
}

export type HatSticker = {
  id: string | number | bigint;
  userId: number;
  team: string;
  cosmeticId: number;
  data: unknown;
};

export type HatPose = { x: number; y: number; scale: number; rotation: number; flip: boolean };

/**
 * A sticker's stored geometry, or null when it is unusable (it is JSON on a row, so nothing
 * guarantees its shape). Position is clamped onto the picture; size into what a hat may be.
 */
export function readHatPose(data: unknown): HatPose | null {
  if (!data || typeof data !== 'object') return null;
  const { x, y, scale, rotation, flip } = data as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const nx = num(x);
  const ny = num(y);
  if (nx === null || ny === null) return null;
  return {
    x: Math.min(1, Math.max(0, nx)),
    y: Math.min(1, Math.max(0, ny)),
    scale: Math.min(
      STICKER_PLACEMENT_MAX_SCALE,
      Math.max(STICKER_PLACEMENT_MIN_SCALE, num(scale) ?? HAT_DEFAULT_SCALE)
    ),
    rotation: num(rotation) ?? 0,
    flip: flip === true,
  };
}

/** Whether a drawn hat is the leading team's (bright) or not (dim). No leader: all plain. */
export function hatTone(team: string, leader: string | null): 'lead' | 'dim' | 'plain' {
  if (!leader) return 'plain';
  return team === leader ? 'lead' : 'dim';
}

/**
 * A push replaces the image's counts; the push does not carry `hatted`, so that stays what the
 * last read said. `null` counts (the last sticker is gone) removes the image's turf.
 */
export function applyTurfPush(
  images: Record<number, TurfSummary>,
  imageId: number,
  counts: Omit<TurfSummary, 'hatted'> | null
): Record<number, TurfSummary> {
  if (!counts) {
    if (!(imageId in images)) return images;
    const { [imageId]: _gone, ...rest } = images;
    return rest;
  }
  return { ...images, [imageId]: { ...counts, hatted: images[imageId]?.hatted ?? false } };
}

/** Reads a turf push off the wire; null for anything not for this event or not shaped like one. */
export function readTurfPush(push: unknown, event: string) {
  const { event: e, imageId, counts } = (push ?? {}) as Record<string, unknown>;
  if (e !== event || typeof imageId !== 'number' || !Number.isInteger(imageId)) return null;
  if (counts === null) return { imageId, counts: null };
  if (!counts || typeof counts !== 'object') return null;
  const c = counts as Record<string, unknown>;
  const record = (v: unknown) =>
    v && typeof v === 'object'
      ? (Object.fromEntries(
          Object.entries(v as object).filter(([, n]) => typeof n === 'number' && Number.isFinite(n))
        ) as TurfCounted)
      : null;
  const shown = record(c.shown);
  const counted = record(c.counted);
  if (!shown || !counted) return null;
  return {
    imageId,
    counts: {
      shown,
      counted,
      leader: typeof c.leader === 'string' ? c.leader : null,
      leaderCosmeticId: typeof c.leaderCosmeticId === 'number' ? c.leaderCosmeticId : null,
    },
  };
}

/** The signal topic a card listens on for one image's counts; must match the server's `eventTurfTopic`. */
export const turfTopic = (event: string, imageId: number) =>
  `${SignalTopic.EventPoints}:${event}:turf:${imageId}` as const;
