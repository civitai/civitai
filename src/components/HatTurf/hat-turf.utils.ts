import { SignalTopic } from '~/server/common/enums';
import { CollectionMode } from '~/shared/utils/prisma/enums';
import { TURF_FEED_STICKERS } from '~/server/schema/turf.schema';
import type { TurfHatArt } from '~/server/schema/turf.schema';
import {
  normalizeStickerPlacement,
  STICKER_PLACEMENT_DEFAULT_SCALE,
} from '~/shared/utils/sticker-placement';

export type TurfCounted = Record<string, number>;

/** A team colour the theme does not know. */
export const FALLBACK_COLOR = 'var(--mantine-color-gray-6)';

export type TurfSummary = {
  shown: TurfCounted;
  counted: TurfCounted;
  leader: string | null;
  leaderCosmeticId: number | null;
  hatted: boolean;
  /** The team whose hat protects the image; null when none does. */
  hattedTeam: string | null;
};

/** Radius of the ring's circle in the badge's 44-unit box; the arcs are drawn on it. */
export const RING_RADIUS = 20;
export const RING_LENGTH = 2 * Math.PI * RING_RADIUS;
const ARC_GAP = 2.2;

/** Teams in a fixed order, so an arc keeps its place on the ring when the lead changes. */
export const orderedTeams = (counted: TurfCounted) => Object.keys(counted).sort();

export type RingArc = { team: string; length: number; offset: number };

/**
 * One arc per team, its length its share of the hats that count. A team with none keeps a
 * zero-length arc so the CSS transition can grow it in place.
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

export type BadgeFigure = {
  /** What the image earns per action: the leader's hats, capped at the players the event credits. */
  points: number;
  /** The team earning them, whose colour the disc takes; null when no team has hats here. */
  pointsTeam: string | null;
  /**
   * The viewer's team's position in hats: ahead of the next-closest team (positive), behind the
   * leader (negative), or level (0). Null for a viewer on no team, or an image with no hats.
   */
  margin: number | null;
};

/**
 * How many stickerers an action credits on an image `team` leads: that team's own cap (team-relative,
 * see turfCreditedByTeam), else the viewer's (a payload from before per-team caps).
 */
export function creditedForTeam(
  stock:
    | { creditedPlayers?: number | null; creditedByTeam?: Record<string, number> | null }
    | null
    | undefined,
  team: string | null | undefined
) {
  const own = team ? stock?.creditedByTeam?.[team] : undefined;
  return own ?? stock?.creditedPlayers;
}

/** "47h left", or minutes in the last hour ("12m left"). */
export function formatTimeLeft(ms: number) {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h left` : `${minutes}m left`;
}

/** The numbers in the badge: points in the dial, the viewer's margin beside it. */
export function badgeFigure(
  summary: Pick<TurfSummary, 'counted' | 'leader' | 'hatted' | 'hattedTeam'>,
  viewerTeam: string | null | undefined,
  creditedPlayers: number | null | undefined
): BadgeFigure {
  const lead = badgeLeader(summary);
  const leadCount = lead ? summary.counted[lead] ?? 0 : 0;
  let margin: number | null = null;
  if (lead && viewerTeam) {
    const mine = summary.counted[viewerTeam] ?? 0;
    if (viewerTeam === lead) {
      const others = Object.entries(summary.counted)
        .filter(([team]) => team !== lead)
        .map(([, n]) => n);
      margin = mine - Math.max(0, ...others);
    } else {
      margin = mine - leadCount;
    }
  }
  if (summary.hatted) return { points: 1, pointsTeam: summary.hattedTeam ?? lead, margin };
  return {
    points: creditedPlayers != null ? Math.min(leadCount, creditedPlayers) : leadCount,
    pointsTeam: lead,
    margin,
  };
}

/**
 * How far the badge's disc fills: the image's points against the most it can earn per action (the
 * players the event credits now). Full on a hatted image, whose 1 point is not counted against the
 * cap, and while the cap is unknown.
 */
export function badgeFill(
  figure: Pick<BadgeFigure, 'points'>,
  hatted: boolean,
  creditedPlayers: number | null | undefined
) {
  if (hatted || !creditedPlayers || creditedPlayers <= 0) return 1;
  return Math.min(1, Math.max(0, figure.points / creditedPlayers));
}

/** "+3", "\u22123", "0". */
export const formatMargin = (margin: number) =>
  margin > 0 ? `+${margin}` : margin < 0 ? `\u2212${-margin}` : '0';

/**
 * Every team with hats here, plus the viewer's, most hats first. `toTake` is how many more the
 * viewer's team needs to lead outright: a tie stays with the current leader.
 */
export function teamStandings(
  summary: Pick<TurfSummary, 'counted' | 'leader'>,
  viewerTeam: string | null | undefined
) {
  const counted = { ...summary.counted };
  if (viewerTeam && !(viewerTeam in counted)) counted[viewerTeam] = 0;
  const rows = orderedTeams(counted)
    .map((team) => ({ team, count: counted[team] }))
    .sort((a, b) => b.count - a.count);
  const lead = badgeLeader(summary);
  const toTake =
    lead && viewerTeam && viewerTeam !== lead ? counted[lead] - counted[viewerTeam] + 1 : null;
  return { rows, total: rows.reduce((sum, row) => sum + row.count, 0), lead, toTake };
}

export type HatSticker = {
  id: string | number | bigint;
  userId: number;
  team: string;
  cosmeticId: number;
  data: unknown;
  /** The hat's art; absent from an older server's push, which draws the team cone instead. */
  art?: TurfHatArt | null;
  /** When it was placed. Absent from an older server's push. */
  createdAt?: Date | string | null;
};

export type HatPose = ReturnType<typeof normalizeStickerPlacement>;

/**
 * A sticker's stored geometry, or null when it is unusable (it is JSON on a row, so nothing
 * guarantees its shape). Clamped by the same rules as a sticker.
 */
export function readHatPose(data: unknown): HatPose | null {
  if (!data || typeof data !== 'object') return null;
  const { x, y, scale, rotation, flip } = data as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const nx = num(x);
  const ny = num(y);
  if (nx === null || ny === null) return null;
  return normalizeStickerPlacement({
    x: nx,
    y: ny,
    scale: num(scale) ?? STICKER_PLACEMENT_DEFAULT_SCALE,
    rotation: num(rotation) ?? 0,
    flip: flip === true,
    // Hats are always opaque, whatever a row says.
    opacity: 1,
  });
}

/** A viewer's own hat never dims: on a pale picture a dimmed hat reads as missing. */
export function hatTone(
  team: string,
  leader: string | null,
  own = false
): 'lead' | 'dim' | 'plain' {
  if (!leader) return 'plain';
  if (team === leader) return 'lead';
  return own ? 'plain' : 'dim';
}

/**
 * A push replaces the image's counts; the push does not carry `hatted` or `hattedTeam`, so those stay
 * what the last read said. `null` counts (the last sticker is gone) removes the image's turf.
 */
export function applyTurfPush(
  images: Record<number, TurfSummary>,
  imageId: number,
  counts: Omit<TurfSummary, 'hatted' | 'hattedTeam'> | null
): Record<number, TurfSummary> {
  if (!counts) {
    if (!(imageId in images)) return images;
    const { [imageId]: _gone, ...rest } = images;
    return rest;
  }
  const prev = images[imageId];
  return {
    ...images,
    [imageId]: { ...counts, hatted: prev?.hatted ?? false, hattedTeam: prev?.hattedTeam ?? null },
  };
}

/** Reads a turf push off the wire; null for anything not for this event or not shaped like one. */
export function readTurfPush(push: unknown, event: string) {
  const {
    event: e,
    imageId,
    counts,
    stickers: rawStickers,
  } = (push ?? {}) as Record<string, unknown>;
  if (e !== event || typeof imageId !== 'number' || !Number.isInteger(imageId)) return null;
  // null: the push does not say (keep what is drawn); undefined: none usable, read them back.
  const stickers = rawStickers === null ? null : readPushedStickers(rawStickers);
  if (counts === null) return { imageId, counts: null, stickers };
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
    stickers,
  };
}

/** The hats a push carries; undefined when it carries none usable (an older server), so the card reads them. */
function readPushedStickers(raw: unknown): HatSticker[] | undefined {
  if (!Array.isArray(raw) || raw.length > TURF_FEED_STICKERS) return undefined;
  const ok = raw.every((s) => {
    const r = (s ?? {}) as Record<string, unknown>;
    return (
      (typeof r.id === 'string' || typeof r.id === 'number') &&
      typeof r.userId === 'number' &&
      typeof r.team === 'string' &&
      typeof r.cosmeticId === 'number'
    );
  });
  if (!ok) return undefined;
  return raw.map(({ id, userId, team, cosmeticId, data, art, createdAt }) => ({
    id,
    userId,
    team,
    cosmeticId,
    data,
    ...(readHatArt(art) && { art: readHatArt(art) }),
    ...(typeof createdAt === 'string' && !isNaN(Date.parse(createdAt)) && { createdAt }),
  }));
}

/** A hat's art from a push: a url, with the fit's canvas and bounds only when well-formed. */
function readHatArt(raw: unknown): TurfHatArt | undefined {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r.url !== 'string') return undefined;
  const nums = (v: unknown, n: number) =>
    Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number');
  return {
    url: r.url,
    canvas: nums(r.canvas, 2) ? (r.canvas as [number, number]) : null,
    bounds: nums(r.bounds, 4) ? (r.bounds as [number, number, number, number]) : null,
  };
}

/** The signal topic a card listens on for one image's counts; must match the server's `eventTurfTopic`. */
export const turfTopic = (event: string, imageId: number) =>
  `${SignalTopic.EventPoints}:${event}:turf:${imageId}` as const;

/** Hat counts beside contest entries could sway judging, so no contest collection shows Hat Turf. */
export const collectionHidesHatTurf = (collection?: { mode?: CollectionMode | null } | null) =>
  collection?.mode === CollectionMode.Contest;

/**
 * How long between new hats, compact enough for a phone tile: "30 s", "4 min", "2h 30m". Null when
 * nothing refills. A duration, not a rate: "15/hr" reads as a batch at the end of the hour.
 */
export function formatRefillCadence(perHour: number) {
  if (!Number.isFinite(perHour) || perHour <= 0) return null;
  const seconds = Math.round(3600 / perHour);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const [h, m] = [Math.floor(minutes / 60), minutes % 60];
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** "1.5", "0.75": at most two decimals, none trailing. */
export const formatMultiplier = (multiplier: number) => String(Number(multiplier.toFixed(2)));

/**
 * How full the viewer's hat stock is, 0 to 1, for the hat button's background. Null while the cap
 * is unknown. A stock kept above a lowered cap reads full.
 */
export function stockFill(stock: { available: number; cap: number } | null | undefined) {
  if (!stock || !(stock.cap > 0)) return null;
  return Math.min(1, Math.max(0, stock.available / stock.cap));
}

/**
 * Where the wait for the next hat stands: one hat's refill time and how much of it has passed.
 * Null at the cap (no hat is coming) or with no refill rate.
 */
export function refillTimer(
  stock: { nextAt: Date | null; perHour: number } | null | undefined,
  now: number
) {
  if (!stock?.nextAt || !(stock.perHour > 0)) return null;
  const period = 3_600_000 / stock.perHour;
  const left = Math.min(period, Math.max(0, stock.nextAt.getTime() - now));
  return { period, elapsed: period - left };
}
