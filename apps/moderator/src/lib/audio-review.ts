import { browsingLevels, getBrowsingLevelLabel } from '@civitai/shared';

/**
 * Audio review (`/audio-review`): songs and their covers, on the shared triage shell. Only the
 * Reported tab works today; Appeals, Held and Disputes are shown and arrive later on this page.
 */
export const AUDIO_TABS = ['reported', 'appeals', 'held', 'disputes'] as const;
export type AudioTab = (typeof AUDIO_TABS)[number];
export const DEFAULT_AUDIO_TAB: AudioTab = 'reported';

export const AUDIO_TAB_LABELS: Record<AudioTab, string> = {
  reported: 'Reported',
  appeals: 'Appeals',
  held: 'Held',
  disputes: 'Disputes',
};

/** The tabs that work on this page; the rest render disabled. */
export const LIVE_AUDIO_TABS: readonly AudioTab[] = ['reported'];

export const REPORTED_SORTS = ['oldest', 'newest', 'most'] as const;
export type ReportedSort = (typeof REPORTED_SORTS)[number];
export const REPORTED_SORT_LABELS: Record<ReportedSort, string> = {
  oldest: 'Oldest first',
  newest: 'Newest first',
  most: 'Most reports',
};

export const REPORTED_FILTERS = ['all', 'timed', 'many'] as const;
export type ReportedFilter = (typeof REPORTED_FILTERS)[number];
export const REPORTED_FILTER_LABELS: Record<ReportedFilter, string> = {
  all: 'All',
  timed: 'Has a time',
  many: '3+ reports',
};
/** A song with at least this many reporters is in the "3+ reports" chip. */
export const MANY_REPORTS = 3;

/** The levels a moderator may give a song here: PG to XXX. Removal is its own decision, and the
 *  Minor and POI flags do not apply to songs. */
export const SONG_RATING_LEVELS = browsingLevels;
export const isSongRatingLevel = (level: number) =>
  (SONG_RATING_LEVELS as readonly number[]).includes(level);
export const songRatingLabel = (level: number) => getBrowsingLevelLabel(level);

/**
 * The time in the song a report points at, in seconds, or null. `Report.details.timestampSec` is
 * written by the main app's song report form; older reports and reports on anything else have none,
 * and a malformed value reads as none.
 */
export function reportTimeSec(details: unknown): number | null {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const raw = (details as Record<string, unknown>).timestampSec;
  const value = typeof raw === 'string' && raw.trim() ? Number(raw) : raw;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** One report on a song, as the queue shows it. */
export type SongReport = {
  id: number;
  reason: string;
  /** The violation or stated reason the reporter picked (`reportReasonLabel`). */
  label: string;
  /** The reporter's own words. */
  comment: string | null;
  timeSec: number | null;
  createdAt: Date;
  reporter: { id: number; username: string | null };
  /** Others merged into this report (`alsoReportedBy`). */
  also: number;
};

/** A song with pending reports: one row per song, its reports gathered under it. */
export type ReportedSongRow = {
  id: number;
  /** Withheld from this moderator by the media access rule: no title, media, cover, owner or report
   *  text, only the id and what is waiting. */
  withheld: boolean;
  title: string | null;
  /** The song's storage key; null when withheld. */
  url: string | null;
  coverUrl: string | null;
  nsfwLevel: number;
  ingestion: string;
  owner: { id: number; username: string | null } | null;
  /** When the oldest pending report was filed. */
  waitingSince: Date;
  /** Reporters, merged ones included. */
  reportCount: number;
  reports: SongReport[];
};

/** Labels of a song's reports, most common first, without repeats. */
export function songReportReasons(reports: readonly Pick<SongReport, 'label' | 'also'>[]) {
  const tally = new Map<string, number>();
  for (const r of reports) tally.set(r.label, (tally.get(r.label) ?? 0) + 1 + r.also);
  return [...tally].sort((a, b) => b[1] - a[1]).map(([label]) => label);
}

/** The decisions in key order: 1 Dismiss reports, 2 Remove song, 3 Remove cover, 4 Set rating. */
export const REPORTED_DECISIONS = ['dismiss', 'remove', 'removeCover', 'rate'] as const;

/**
 * Which decision keys a song takes. A withheld song takes none here; Remove cover is not built on
 * this page yet; a removed song can still have its reports dismissed but not be removed or rated.
 */
export function reportedDecisionsEnabled(
  row: Pick<ReportedSongRow, 'withheld' | 'ingestion'>,
  canAct: boolean
): boolean[] {
  if (!canAct || row.withheld) return REPORTED_DECISIONS.map(() => false);
  const removed = row.ingestion === 'Blocked';
  return [true, !removed, false, !removed];
}

/** How a lyrics source reads on the generation card. */
export const LYRICS_SOURCE_LABELS: Record<string, string> = {
  generator: 'Generated with the song',
  user: 'Written by the owner',
  aligned: 'Timed to the audio',
  transcribed: 'Transcribed from the audio',
};

/** A scan's state as a pill: what it decided, never why. */
export type CheckState = 'passed' | 'blocked' | 'held' | 'pending' | 'failed';

/** The pill for a song or cover from its `ingestion`, `needsReview` and `blockedFor`. */
export function checkState(media: {
  ingestion: string;
  needsReview: string | null;
  blockedFor: string | null;
}): CheckState {
  if (media.ingestion === 'Blocked' || media.blockedFor) return 'blocked';
  if (media.needsReview) return 'held';
  if (media.ingestion === 'Scanned') return 'passed';
  if (media.ingestion === 'Error' || media.ingestion === 'NotFound') return 'failed';
  return 'pending';
}

/** What the open song's side cards show, beyond its row. `/audio-review/details/[imageId]`. */
export type SongDetails = {
  facts: {
    durationSec: number | null;
    genre: string | null;
    postId: number | null;
    postedAt: Date | null;
    allowRemix: boolean;
  };
  checks: { song: CheckState; cover: CheckState | null };
  cover: { id: number; url: string | null; nsfwLevel: number; shown: boolean } | null;
  generation: {
    model: string | null;
    seed: string | null;
    prompt: string | null;
    musicDescription: string | null;
    lyricsSource: string | null;
  };
  owner: {
    id: number;
    username: string | null;
    createdAt: Date | null;
    removedSongs: number;
    strikes: number;
    /** Their other songs with a pending report. */
    otherReported: number;
  } | null;
};

export const songDetailsUrl = (imageId: number) => `/audio-review/details/${imageId}`;
