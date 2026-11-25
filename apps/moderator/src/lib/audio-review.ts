import { browsingLevels, getBrowsingLevelLabel } from '@civitai/shared';
import { removedKind, removedTitle, type RemovedState } from '$lib/image-review';
import { VIOLATION_LABELS } from '$lib/violations';

/**
 * Audio review (`/audio-review`): songs and their covers, on the shared triage shell: reports,
 * appeals, holds and owners' rating disputes.
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
  label: string;
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
  url: string | null;
  coverUrl: string | null;
  nsfwLevel: number | null;
  /** Kept on a withheld song for its Removed chip. */
  removed: boolean;
  removal: RemovedState | null;
  owner: { id: number; username: string | null } | null;
  /** When the oldest pending report was filed. */
  waitingSince: Date;
  /** Reporters, merged ones included. */
  reportCount: number;
  reports: SongReport[];
  /** The song's own cover while there is one to remove (`visibleSongLinks`). */
  removableCoverId: number | null;
};

/** Labels of a song's reports, most common first, without repeats. */
export function songReportReasons(reports: readonly Pick<SongReport, 'label' | 'also'>[]) {
  const tally = new Map<string, number>();
  for (const r of reports) tally.set(r.label, (tally.get(r.label) ?? 0) + 1 + r.also);
  return [...tally].sort((a, b) => b[1] - a[1]).map(([label]) => label);
}

/** The decisions in key order: 1 Dismiss reports, 2 Remove song, 3 Remove cover, 4 Set rating. */
export const REPORTED_DECISIONS = ['dismiss', 'remove', 'removeCover', 'rate'] as const;

type DecisionRow = Pick<ReportedSongRow, 'withheld' | 'removed' | 'removal'> &
  Partial<Pick<ReportedSongRow, 'removableCoverId'>>;
const SONG_VERBS = { restore: 'Restore and dismiss', remove: 'Remove song' };

/** A CSAM-removed or CSAM-review song takes nothing: the CSAM queue owns it. */
export function reportedDecisionsEnabled(row: DecisionRow, canAct: boolean): boolean[] {
  if (!canAct || row.withheld) return REPORTED_DECISIONS.map(() => false);
  const cover = row.removableCoverId != null;
  if (!row.removed || !row.removal) return [true, true, cover, true];
  switch (removedKind(row.removal)) {
    case 'rule':
    case 'other':
      return [true, true, cover, false];
    case 'moderator':
      return [true, false, cover, false];
    default:
      return [false, false, false, false];
  }
}

/** Key 1's label and the outcome it shows once pressed. */
export function dismissDecision(row: DecisionRow): { label: string; outcome: string } {
  const kind = row.removed && row.removal ? removedKind(row.removal) : null;
  if (kind === 'rule' || kind === 'other')
    return { label: 'Restore and dismiss', outcome: 'Restored, reports dismissed' };
  if (kind === 'moderator') return { label: 'Close reports', outcome: 'Closed: already removed' };
  return { label: 'Dismiss reports', outcome: 'Reports dismissed' };
}

/** The Removed chip's tooltip, in this page's verbs. */
export const songRemovedTitle = (row: DecisionRow) =>
  row.removal ? removedTitle(row.removal, SONG_VERBS) : 'Removed';

/** What a decided song shows: the writer's own word when it did something other than asked (a
 *  removal held for a second moderator, reports closed on a song already removed). */
export function reportedOutcome(
  result: { type: string; data?: Record<string, unknown> },
  outcome: string
): string {
  if (result.type !== 'success') return outcome;
  if (typeof result.data?.held === 'string') return result.data.held;
  if (result.data?.alreadyRemoved) return 'Closed: already removed';
  return outcome;
}

/** The rating keys while the picker is open: every level the song can be given but the one it has. */
export const ratingKeysEnabled = (current: number | null, canRate: boolean) =>
  SONG_RATING_LEVELS.map((level) => canRate && level !== current);

/** How a lyrics source reads on the generation card. */
export const LYRICS_SOURCE_LABELS: Record<string, string> = {
  generator: 'Generated with the song',
  user: 'Written by the owner',
  aligned: 'Timed to the audio',
  transcribed: 'Transcribed from the audio',
};

/** A scan's state as a pill: what it decided, never why. */
export type CheckState = 'passed' | 'blocked' | 'held' | 'pending' | 'failed';

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

/** Appeals tab chips: every appeal, a song's own, or a cover's. */
export const APPEAL_FILTERS = ['all', 'song', 'cover'] as const;
export type AppealFilter = (typeof APPEAL_FILTERS)[number];
export const APPEAL_FILTER_LABELS: Record<AppealFilter, string> = {
  all: 'All',
  song: 'Song',
  cover: 'Cover',
};
export const APPEAL_SORTS = ['oldest', 'newest'] as const;
export type AppealSort = (typeof APPEAL_SORTS)[number];

/** An owner's Pending appeal of a removed song or of a song's removed cover, one row per appeal. */
export type SongAppealRow = {
  /** The appealed image: the song, or the cover. */
  id: number;
  appealId: number;
  kind: 'song' | 'cover';
  /** Withheld from this moderator by the media access rule: only the id, the kind and the wait. */
  withheld: boolean;
  /** On a cover appeal, the song it is the cover of; null when that song is withheld. */
  song: { id: number; title: string | null } | null;
  url: string | null;
  coverUrl: string | null;
  owner: { id: number; username: string | null } | null;
  waitingSince: Date;
  message: string | null;
  removal: { reason: string | null; by: string | null; at: Date | null } | null;
  /** This image's appeals so far, this one included. */
  appeals: number;
  nsfwLevel: number | null;
};

/** The decisions in key order: 1 Approve appeal (restores what was appealed), 2 Reject appeal. */
export const APPEAL_DECISIONS = ['approveAppeal', 'rejectAppeal'] as const;

/** Neither decision on a withheld appeal, nor without the grant. */
export const appealDecisionsEnabled = (row: Pick<SongAppealRow, 'withheld'>, canAct: boolean) =>
  APPEAL_DECISIONS.map(() => canAct && !row.withheld);

/** A removal's reason as moderators read it: the violation type recorded with it, else why it is
 *  blocked. */
export function removalReasonLabel(tosReason: string | null, blockedFor: string | null): string {
  const raw = tosReason ?? blockedFor;
  if (!raw) return 'TOS violation';
  return (
    VIOLATION_LABELS[raw as keyof typeof VIOLATION_LABELS] ??
    raw.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
  );
}

/** How a song reads in a list or a detail header. */
export const songTitle = (song: { id: number; withheld: boolean; title: string | null }) =>
  song.withheld ? `Withheld song #${song.id}` : song.title || `Untitled song #${song.id}`;

export const appealRowTitle = (row: Pick<SongAppealRow, 'id' | 'kind' | 'withheld' | 'song'>) => {
  if (row.withheld) return `Withheld ${row.kind} #${row.id}`;
  const title = row.song ? songTitle({ ...row.song, withheld: false }) : null;
  return row.kind === 'song' ? title ?? `Song #${row.id}` : `Cover: ${title ?? `image #${row.id}`}`;
};

/**
 * What holds a song on the Held tab: its lyrics under a CSAM text hold (decided in CSAM holds), its
 * own cover flagged for review, or the song itself flagged for review.
 */
export const HELD_KINDS = ['lyrics', 'cover', 'song'] as const;
export type HeldKind = (typeof HELD_KINDS)[number];
export const HELD_FILTERS = ['all', ...HELD_KINDS] as const;
export type HeldFilter = (typeof HELD_FILTERS)[number];
export const HELD_FILTER_LABELS: Record<HeldFilter, string> = {
  all: 'All',
  lyrics: 'Lyrics',
  cover: 'Cover',
  song: 'Song',
};
export const HELD_SORTS = ['oldest', 'newest'] as const;
export type HeldSort = (typeof HELD_SORTS)[number];

/** One held song. A lyrics hold is withheld from every moderator on this page: its song, cover,
 *  lyrics and owner are seen only in CSAM holds. A cover or song withheld from this moderator by the
 *  media access rule carries only its id, kind and wait too. */
export type HeldSongRow = {
  /** The song. */
  id: number;
  kind: HeldKind;
  withheld: boolean;
  holdId: number | null;
  /** Since the hold was written (lyrics), or the flagged image was uploaded. */
  waitingSince: Date;
  title: string | null;
  url: string | null;
  /** The cover as the public player shows it, so never a flagged one. */
  coverUrl: string | null;
  /** The flagged cover under review, on a cover row. */
  cover: { id: number; url: string; flag: string; nsfwLevel: number } | null;
  /** The song's own review flag, on a song row. */
  flag: string | null;
  nsfwLevel: number | null;
  owner: { id: number; username: string | null } | null;
  removed: boolean;
  removableCoverId: number | null;
};

const HELD_DECISIONS = {
  lyrics: ['openHold'],
  cover: ['approveCover', 'removeCover', 'removeSong', 'rate'],
  song: ['approveSong', 'removeSong', 'removeCover', 'rate'],
} as const satisfies Record<HeldKind, readonly string[]>;

export const heldDecisions = (kind: HeldKind): readonly string[] => HELD_DECISIONS[kind];

type HeldDecisionRow = Pick<HeldSongRow, 'kind' | 'withheld' | 'removed' | 'removableCoverId'> & {
  cover: unknown;
};

export function heldDecisionsEnabled(
  row: HeldDecisionRow,
  canAct: boolean,
  canOpenHolds: boolean
): boolean[] {
  if (row.kind === 'lyrics') return [canOpenHolds];
  const on = canAct && !row.withheld;
  const live = on && !row.removed;
  const cover = on && row.removableCoverId != null;
  return row.kind === 'cover'
    ? [on && row.cover != null, cover, live, live]
    : [on, live, cover, live];
}

/** A lyrics hold in CSAM holds: its song's pending lyrics hold. */
export const lyricsHoldHref = (songId: number) =>
  `/csam/text-holds?entityType=TrackLyrics&q=${songId}`;

/** Disputes tab chips: every dispute, or those asking for a lower or a higher rating. */
export const DISPUTE_FILTERS = ['all', 'lower', 'higher'] as const;
export type DisputeFilter = (typeof DISPUTE_FILTERS)[number];
export const DISPUTE_SORTS = ['oldest', 'newest'] as const;
export type DisputeSort = (typeof DISPUTE_SORTS)[number];

/** `gone`: deleted, removed or never to be reviewed, so a ruling closes the dispute and applies
 *  nothing (the resolver's missing-entity path). */
export type DisputeSongState = 'reviewed' | 'unreviewed' | 'gone';

/** An owner's Pending rating dispute on a song (`RatingReview` entity type `Song`), one row each. */
export type SongDisputeRow = {
  /** The dispute (`RatingReview.id`). */
  id: number;
  songId: number;
  /** Withheld from this moderator by the media access rule: only the ids and the wait. */
  withheld: boolean;
  waitingSince: Date;
  title: string | null;
  url: string | null;
  coverUrl: string | null;
  owner: { id: number; username: string | null } | null;
  /** The level the owner saw when they disputed it; the ruling is judged on `songLevel`. */
  currentLevel: number | null;
  suggestedLevel: number | null;
  songLevel: number | null;
  message: string | null;
  state: DisputeSongState | null;
  /** This song's disputes so far, this one included. */
  disputes: number | null;
  /** The last ruling on an earlier dispute of this song. */
  earlier: { status: string; appliedLevel: number | null; resolvedAt: Date | null } | null;
};

/** The rating keys: 1 to 5 apply PG to XXX. None on a withheld song, a song its scans have not
 *  reviewed, or without the grant. */
export const disputeKeysEnabled = (
  row: Pick<SongDisputeRow, 'withheld' | 'state'>,
  canAct: boolean
) => SONG_RATING_LEVELS.map(() => canAct && !row.withheld && row.state !== 'unreviewed');

export const disputeRowTitle = (row: Pick<SongDisputeRow, 'songId' | 'withheld' | 'title'>) =>
  songTitle({ ...row, id: row.songId });
