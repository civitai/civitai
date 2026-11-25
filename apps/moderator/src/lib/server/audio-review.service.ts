import { sql } from '@civitai/db/kysely';
import { playerSongCoverText, songsOwnCoverText } from '@civitai/db-queries/profile-picture-clear';
import { storedSongDurationSec } from '@civitai/shared';
import { songNeverReviewable, songScanStateOf } from '@civitai/shared/rating-review';
import {
  type AudioTab,
  type CheckState,
  checkState,
  DEFAULT_AUDIO_TAB,
  LYRICS_SOURCE_LABELS,
  MANY_REPORTS,
  reportTimeSec,
  removalReasonLabel,
  type AppealFilter,
  type AppealSort,
  type DisputeFilter,
  type DisputeSongState,
  type DisputeSort,
  type DisputeStatus,
  type HeldFilter,
  type HeldKind,
  type HeldSongRow,
  type HeldSort,
  type ReportedFilter,
  type SongAppealRow,
  type ReportedSongRow,
  type ReportedSort,
  type SongDetails,
  type SongDisputeRow,
  type SongReport,
} from '$lib/audio-review';
import { ReportStatus, SONG_ENTITY_TYPE } from '$lib/rating-review';
import { reportDetail, reportReasonLabel } from '$lib/reports';
import {
  flaggedCoverText,
  flaggedSongsText,
  pendingSongDisputes,
  pendingSongReports,
  songAppealImages,
} from './audio-review-count';
import { canAccess } from './access';
import { logAxiomError } from './axiom';
import { getClickhouse } from './clickhouse';
import { dbRead } from './db';
import { getAppealImageQueue, ruleBlockedSql } from './image-review.service';
import { visibleSongLinks } from './song-links.service';
import { int4Id } from './query';
import { holdsCsamReview } from './held-media';
import { withheldImageIds } from './retracted-media';
import { getActiveStrikes } from './user-lookup.service';

/** Per song: when its oldest report was filed, how many reported it, whether any report has a
 *  time, and what a text search matches (its title and owner). */
const songGroups = () =>
  pendingSongReports()
    .innerJoin('User as owner', 'owner.id', 'i.userId')
    .select([
      'i.id',
      sql<string | null>`i.metadata->>'title'`.as('title'),
      'owner.username',
      sql<Date>`min(r."createdAt")`.as('waitingSince'),
      sql<number>`sum(1 + coalesce(array_length(r."alsoReportedBy", 1), 0))::int`.as('reportCount'),
      sql<boolean>`bool_or(r.details ? 'timestampSec')`.as('hasTime'),
    ])
    .groupBy(['i.id', 'owner.username']);

type SongGroup = Awaited<ReturnType<ReturnType<typeof songGroups>['execute']>>[number];

const PAGE_SIZE = 50;

/** A text search over the songs it may name: title anywhere, owner username from the start. */
function matchesText(group: SongGroup, q: string) {
  const term = q.toLowerCase();
  return (
    !!group.title?.toLowerCase().includes(term) || !!group.username?.toLowerCase().startsWith(term)
  );
}

const byWait = (a: SongGroup, b: SongGroup) =>
  new Date(a.waitingSince).getTime() - new Date(b.waitingSince).getTime() || a.id - b.id;
const SORTS: Record<ReportedSort, (a: SongGroup, b: SongGroup) => number> = {
  oldest: byWait,
  newest: (a, b) => byWait(b, a),
  most: (a, b) => b.reportCount - a.reportCount || byWait(a, b),
};

/** One page of reported songs, the total under the filters, and the chip counts under the search.
 *  Filtered here, not in SQL: what a moderator may search on depends on the media access rule (a
 *  withheld song matches only its exact id, and its report times count for no chip). */
export async function getReportedSongs({
  sort,
  filter,
  q,
  page,
  user,
}: {
  sort: ReportedSort;
  filter: ReportedFilter;
  q: string;
  page: number;
  user: App.Locals['user'] | undefined;
}) {
  const groups = await songGroups().execute();
  const withheld = new Set(
    await withheldImageIds(
      user,
      groups.map((g) => g.id)
    )
  );
  const asId = /^\d+$/.test(q) ? int4Id.safeParse(q) : null;
  const searched = !q
    ? groups
    : groups.filter((g) =>
        asId?.success ? g.id === asId.data : !withheld.has(g.id) && matchesText(g, q)
      );
  const timed = (g: SongGroup) => g.hasTime && !withheld.has(g.id);
  const many = (g: SongGroup) => g.reportCount >= MANY_REPORTS;
  const facets = {
    all: searched.length,
    timed: searched.filter(timed).length,
    many: searched.filter(many).length,
  };
  const filtered = searched
    .filter((g) => (filter === 'timed' ? timed(g) : filter === 'many' ? many(g) : true))
    .sort(SORTS[sort]);
  const offset = (page - 1) * PAGE_SIZE;
  const pageIds = filtered.slice(offset, offset + PAGE_SIZE).map((g) => g.id);
  const items = await getReportedSongRows(pageIds, user, withheld);
  return {
    items,
    hasMore: filtered.length > offset + PAGE_SIZE,
    total: facets[filter],
    facets,
    offset,
    pageSize: PAGE_SIZE,
  };
}

/** The rows of these songs with their Pending reports, in the order given. A song withheld from
 *  `user` comes back as `withheldSongRow`. A song with no Pending report left is dropped. */
export async function getReportedSongRows(
  imageIds: number[],
  user: App.Locals['user'] | undefined,
  /** The songs already known to be withheld from `user`, when the caller has read them. */
  knownWithheld?: Set<number>
): Promise<ReportedSongRow[]> {
  if (!imageIds.length) return [];
  const [songs, reports, withheld, links] = await Promise.all([
    dbRead
      .selectFrom('Image as s')
      .innerJoin('User as owner', 'owner.id', 's.userId')
      .leftJoin('Track as t', 't.imageId', 's.id')
      .leftJoin('Image as c', 'c.id', 't.coverImageId')
      .select([
        's.id',
        's.url',
        's.nsfwLevel',
        's.ingestion',
        's.needsReview',
        's.blockedFor',
        ruleBlockedSql('s').as('ruleBlocked'),
        sql<string | null>`s.metadata->>'title'`.as('title'),
        'owner.id as ownerId',
        'owner.username as ownerUsername',
        'c.id as coverId',
        sql<string | null>`CASE WHEN ${sql.raw(songsOwnCoverText('c', 's'))} AND ${sql.raw(
          playerSongCoverText('c')
        )} THEN c.url END`.as('coverUrl'),
      ])
      .where('s.id', 'in', imageIds)
      .where('s.type', '=', 'audio')
      .execute(),
    pendingSongReports()
      .innerJoin('User as ru', 'ru.id', 'r.userId')
      .select([
        'ir.imageId',
        'r.id',
        'r.reason',
        'r.details',
        'r.createdAt',
        'ru.id as reporterId',
        'ru.username as reporterUsername',
        sql<number>`coalesce(array_length(r."alsoReportedBy", 1), 0)::int`.as('also'),
      ])
      .where('ir.imageId', 'in', imageIds)
      .orderBy('r.createdAt', 'asc')
      .orderBy('r.id', 'asc')
      .execute(),
    knownWithheld ? [...knownWithheld] : withheldImageIds(user, imageIds),
    visibleSongLinks(imageIds, user),
  ]);
  const withheldSet = new Set(withheld);
  const coversWithheld = await withheldCovers(songs, user);
  const reportsBySong = new Map<number, SongReport[]>();
  for (const r of reports) {
    const list = reportsBySong.get(r.imageId) ?? [];
    list.push({
      id: r.id,
      reason: String(r.reason),
      label: reportReasonLabel(r.details, String(r.reason)),
      comment: reportDetail(r.details, 'comment')?.trim() || null,
      timeSec: reportTimeSec(r.details),
      createdAt: r.createdAt,
      reporter: { id: r.reporterId, username: r.reporterUsername },
      also: r.also,
    });
    reportsBySong.set(r.imageId, list);
  }
  const byId = new Map(songs.map((s) => [s.id, s]));
  return imageIds.flatMap((id): ReportedSongRow[] => {
    const song = byId.get(id);
    const songReports = reportsBySong.get(id);
    if (!song || !songReports?.length) return [];
    const row: ReportedSongRow = {
      id,
      withheld: false,
      title: song.title || null,
      url: song.url,
      coverUrl: shownThumb(song, coversWithheld),
      nsfwLevel: song.nsfwLevel,
      removed: song.ingestion === 'Blocked',
      removal:
        song.ingestion === 'Blocked'
          ? {
              needsReview: song.needsReview,
              blockedFor: song.blockedFor,
              ruleBlocked: !!song.ruleBlocked,
            }
          : null,
      owner: { id: song.ownerId, username: song.ownerUsername },
      waitingSince: songReports[0].createdAt,
      reportCount: songReports.reduce((n, r) => n + 1 + r.also, 0),
      reports: songReports,
      removableCoverId: links.get(id)?.songCoverId ?? null,
    };
    return [withheldSet.has(id) ? withheldSongRow(row) : row];
  });
}

/** The covers among these rows' thumbnails withheld from `user`: the list hides them, as the open
 *  song's cover card does (`getSongDetails`). */
async function withheldCovers(
  rows: { coverId: number | null; coverUrl: string | null }[],
  user: App.Locals['user'] | undefined
) {
  const ids = rows.flatMap((r) => (r.coverUrl && r.coverId != null ? [r.coverId] : []));
  return new Set(ids.length ? await withheldImageIds(user, ids) : []);
}

const shownThumb = (
  row: { coverId: number | null; coverUrl: string | null },
  withheld: Set<number>
) => (row.coverId != null && withheld.has(row.coverId) ? null : row.coverUrl);

/**
 * A song withheld from this moderator: what is waiting (its id, when, how many) and nothing that
 * shows or names it. The reports keep their ids and times, so the queue still ages it, but lose
 * their reason, words and time in the song.
 */
export function withheldSongRow(row: ReportedSongRow): ReportedSongRow {
  return {
    ...row,
    withheld: true,
    title: null,
    url: null,
    coverUrl: null,
    nsfwLevel: null,
    removal: null,
    owner: null,
    removableCoverId: null,
    reports: row.reports.map((r) => ({
      ...r,
      reason: '',
      label: '',
      comment: null,
      timeSec: null,
      reporter: { id: 0, username: null },
    })),
  };
}

/** The posted reports a decision on song `imageId` may close: Pending ones filed on that song. A
 *  stale or forged id, or one on another image, is left out. */
export async function boundSongReports(imageId: number, reportIds: number[]): Promise<number[]> {
  if (!reportIds.length) return [];
  const rows = await pendingSongReports()
    .select('r.id')
    .where('ir.imageId', '=', imageId)
    .where('r.id', 'in', reportIds)
    .execute();
  const bound = new Set(rows.map((r) => r.id));
  return reportIds.filter((id) => bound.has(id));
}

const textOf = (value: unknown) =>
  typeof value === 'string' && value.trim()
    ? value.trim()
    : typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : null;

/** The model a generated song names first in `meta.civitaiResources`, as "Model · Version". */
async function songModelName(meta: Record<string, unknown> | null): Promise<string | null> {
  const resources = Array.isArray(meta?.civitaiResources) ? meta.civitaiResources : [];
  const versionId = resources
    .map((r) => Number((r as { modelVersionId?: unknown } | null)?.modelVersionId))
    .find((id) => int4Id.safeParse(id).success);
  if (versionId == null) return textOf(meta?.ecosystem);
  const row = await dbRead
    .selectFrom('ModelVersion as mv')
    .innerJoin('Model as m', 'm.id', 'mv.modelId')
    .select(['m.name as model', 'mv.name as version'])
    .where('mv.id', '=', versionId)
    .executeTakeFirst();
  return row ? `${row.model} · ${row.version}` : textOf(meta?.ecosystem);
}

/** The open song's facts, scans, cover, generation and owner (`SongDetails`), or null when it is
 *  not a song. The caller refuses a song withheld from the moderator before calling this; the cover
 *  is checked here, and its file is sent only when the public player would show it and it is not
 *  withheld from `user`. */
export async function getSongDetails(
  imageId: number,
  user: App.Locals['user'] | undefined,
  tab: AudioTab = DEFAULT_AUDIO_TAB,
  /** Whether this moderator may open CSAM holds: only then is a lyrics hold named as one. */
  canOpenHolds = false
): Promise<SongDetails | null> {
  const song = await dbRead
    .selectFrom('Image as s')
    .leftJoin('Track as t', 't.imageId', 's.id')
    .leftJoin('Image as c', 'c.id', 't.coverImageId')
    .leftJoin('Post as p', 'p.id', 's.postId')
    .leftJoin('TrackLyrics as l', 'l.imageId', 's.id')
    .select([
      's.id',
      's.userId',
      's.ingestion',
      's.needsReview',
      's.blockedFor',
      's.postId',
      's.meta',
      's.metadata',
      's.nsfwLevelLocked',
      's.scannedAt',
      't.genre',
      'p.publishedAt',
      'l.source as lyricsSource',
      'l.imageId as lyricsId',
      'c.id as coverId',
      'c.url as coverUrl',
      'c.nsfwLevel as coverNsfwLevel',
      'c.ingestion as coverIngestion',
      'c.needsReview as coverNeedsReview',
      'c.blockedFor as coverBlockedFor',
      sql<boolean>`COALESCE(${sql.raw(songsOwnCoverText('c', 's'))} AND ${sql.raw(
        playerSongCoverText('c')
      )}, false)`.as('coverShown'),
    ])
    .where('s.id', '=', imageId)
    .where('s.type', '=', 'audio')
    .executeTakeFirst();
  if (!song) return null;

  const meta = (song.meta as Record<string, unknown> | null) ?? null;
  const metadata = (song.metadata as Record<string, unknown> | null) ?? null;
  const [model, owner, strikes, coverWithheld] = await Promise.all([
    songModelName(meta),
    dbRead
      .selectFrom('User as u')
      .select([
        'u.id',
        'u.username',
        'u.createdAt',
        (eb) =>
          eb
            .selectFrom('Image as o')
            .select(sql<number>`count(*)::int`.as('n'))
            .whereRef('o.userId', '=', 'u.id')
            .where('o.type', '=', 'audio')
            .where('o.ingestion', '=', 'Blocked')
            .as('removedSongs'),
      ])
      .where('u.id', '=', song.userId)
      .executeTakeFirst(),
    getActiveStrikes(song.userId),
    song.coverId != null ? withheldImageIds(user, [song.coverId]) : [],
  ]);
  const [otherReported, otherHeld, lyrics, ownerDisputes, rating, activity] = await Promise.all([
    pendingSongReports()
      .select('i.id')
      .distinct()
      .where('i.userId', '=', song.userId)
      .where('i.id', '<>', imageId)
      .execute()
      .then((rows) =>
        visibleIds(
          rows.map((r) => r.id),
          user
        )
      ),
    tab === 'held' ? otherHeldOf(song.userId, imageId, user) : null,
    song.lyricsId != null ? lyricsCheck(imageId, canOpenHolds) : null,
    tab === 'disputes' ? songDisputeTally(song.userId, user) : null,
    tab === 'disputes'
      ? songRatingSource(imageId, { locked: song.nsfwLevelLocked, scannedAt: song.scannedAt })
      : null,
    tab === 'disputes' || tab === 'reported' ? songActivity(imageId) : null,
  ]);

  const cover =
    song.coverId != null
      ? {
          id: song.coverId,
          url: song.coverShown && !coverWithheld.length ? song.coverUrl ?? null : null,
          nsfwLevel: song.coverNsfwLevel ?? 0,
          shown: song.coverShown,
        }
      : null;
  return {
    facts: {
      durationSec: storedSongDurationSec(metadata?.duration),
      genre: song.genre ?? null,
      postId: song.postId,
      postedAt: song.publishedAt ?? null,
      allowRemix: metadata?.allowRemix !== false,
    },
    checks: {
      song: checkState({
        ingestion: String(song.ingestion),
        needsReview: song.needsReview,
        blockedFor: song.blockedFor,
      }),
      lyrics,
      cover:
        song.coverId != null
          ? checkState({
              ingestion: String(song.coverIngestion),
              needsReview: song.coverNeedsReview ?? null,
              blockedFor: song.coverBlockedFor ?? null,
            })
          : null,
    },
    cover,
    generation: {
      model,
      seed: textOf(meta?.seed),
      prompt: textOf(meta?.prompt),
      musicDescription: textOf(meta?.musicDescription),
      lyricsSource: song.lyricsSource
        ? LYRICS_SOURCE_LABELS[String(song.lyricsSource)] ?? String(song.lyricsSource)
        : null,
    },
    owner: owner
      ? {
          id: owner.id,
          username: owner.username,
          createdAt: owner.createdAt ?? null,
          removedSongs: Number(owner.removedSongs ?? 0),
          strikes: strikes.count,
          otherReported: otherReported.length,
          otherHeld,
          disputes: ownerDisputes,
        }
      : null,
    rating,
    activity,
  };
}

// A lyrics hold is decided in CSAM holds, whose page refuses to load without this grant.
const CSAM_HOLDS = '/csam/text-holds';
const CSAM_HOLDS_GRANT = 'csam.report.file';

/** Whether this moderator can open CSAM holds: its page and the grant its load demands. */
export const canOpenCsamHolds = (locals: Pick<App.Locals, 'user' | 'grants'>) =>
  canAccess(locals.user, CSAM_HOLDS) && !!locals.grants[CSAM_HOLDS_GRANT];

/** Which of `ids` are not withheld from `user`: an owner's counts leave those out, as the lists do. */
async function visibleIds(ids: number[], user: App.Locals['user'] | undefined) {
  if (!ids.length) return [];
  const withheld = new Set(await withheldImageIds(user, ids));
  return ids.filter((id) => !withheld.has(id));
}

/** The lyrics scan's state: held while a CSAM text hold is Pending (pending to a moderator who
 *  cannot open CSAM holds), else the text moderation's verdict (`EntityModeration`, as the main
 *  app's song decision reads it). */
async function lyricsCheck(songId: number, canOpenHolds: boolean): Promise<CheckState> {
  const [hold, moderation] = await Promise.all([
    dbRead
      .selectFrom('TextScanHold')
      .select('id')
      .where('entityType', '=', 'TrackLyrics')
      .where('entityId', '=', songId)
      .where('label', '=', 'csam')
      .where(sql<boolean>`status = 'Pending'`)
      .executeTakeFirst(),
    dbRead
      .selectFrom('EntityModeration')
      .select(['status', 'blocked'])
      .where('entityType', '=', 'TrackLyrics')
      .where('entityId', '=', songId)
      .executeTakeFirst(),
  ]);
  if (hold) return canOpenHolds ? 'held' : 'pending';
  if (!moderation || moderation.status === 'Pending') return 'pending';
  if (moderation.status !== 'Succeeded') return 'failed';
  return moderation.blocked ? 'blocked' : 'passed';
}

/** An owner's rating disputes on songs, by outcome, leaving out songs withheld from `user`. */
async function songDisputeTally(ownerId: number, user: App.Locals['user'] | undefined) {
  const all = await dbRead
    .selectFrom('RatingReview')
    .select(['entityId', 'status', sql<number>`count(*)::int`.as('n')])
    .where('entityType', '=', SONG_ENTITY_TYPE)
    .where('userId', '=', ownerId)
    .groupBy(['entityId', 'status'])
    .execute();
  const visible = new Set(await visibleIds([...new Set(all.map((r) => r.entityId))], user));
  const rows = all.filter((r) => visible.has(r.entityId));
  const of = (status: string) =>
    rows.filter((r) => String(r.status) === status).reduce((n, r) => n + r.n, 0);
  return {
    total: rows.reduce((n, r) => n + r.n, 0),
    pending: of(ReportStatus.Pending),
    approved: of(ReportStatus.Actioned),
    rejected: of(ReportStatus.Unactioned),
  };
}

// The rating writer records its activity after the ruling commits: a ruling this close before the
// latest rating activity is that same change.
const RULING_ACTIVITY_SLACK_MS = 60_000;

/** Who set the song's current level: its scans while it is unlocked, else the moderator rating
 *  writer's latest `setNsfwLevel` activity or a dispute ruling that applied a level. */
async function songRatingSource(
  songId: number,
  song: { locked: boolean; scannedAt: Date | null }
): Promise<NonNullable<SongDetails['rating']>> {
  if (!song.locked) return { source: 'scan', by: null, at: song.scannedAt, before: null };
  const [activity, ruling] = await Promise.all([
    dbRead
      .selectFrom('ModActivity as a')
      .leftJoin('User as u', 'u.id', 'a.userId')
      .select(['u.username', 'a.createdAt'])
      .where('a.entityType', '=', 'image')
      .where('a.entityId', '=', songId)
      .where('a.activity', '=', 'setNsfwLevel')
      .orderBy('a.createdAt', 'desc')
      .limit(1)
      .executeTakeFirst(),
    dbRead
      .selectFrom('RatingReview as rr')
      .leftJoin('User as u', 'u.id', 'rr.resolvedBy')
      .select(['u.username', 'rr.resolvedAt', 'rr.currentLevel'])
      .where('rr.entityType', '=', SONG_ENTITY_TYPE)
      .where('rr.entityId', '=', songId)
      .where('rr.appliedLevel', 'is not', null)
      .where('rr.resolvedAt', 'is not', null)
      .orderBy('rr.resolvedAt', 'desc')
      .limit(1)
      .executeTakeFirst(),
  ]);
  const rulingAt = ruling?.resolvedAt ? new Date(ruling.resolvedAt).getTime() : null;
  if (
    ruling &&
    rulingAt != null &&
    (!activity || rulingAt >= new Date(activity.createdAt).getTime() - RULING_ACTIVITY_SLACK_MS)
  )
    return {
      source: 'moderator',
      by: ruling.username ?? null,
      at: ruling.resolvedAt,
      before: ruling.currentLevel,
    };
  if (activity)
    return {
      source: 'moderator',
      by: activity.username ?? null,
      at: activity.createdAt,
      before: null,
    };
  return { source: 'unknown', by: null, at: null, before: null };
}

/** All-time plays, Like reactions and comments of one song from the image metrics the site counts
 *  (`entityMetricDailyAgg_v2`, summed per day as the main app's metric reader does); null when
 *  ClickHouse cannot answer, so the card leaves the row out rather than show zeros. */
async function songActivity(songId: number): Promise<SongDetails['activity']> {
  try {
    const response = await getClickhouse().query({
      query: `
        SELECT metricType, sum(total) AS value
        FROM entityMetricDailyAgg_v2
        WHERE entityType = 'Image' AND entityId = {songId:Int32}
          AND metricType IN ('Play', 'Like', 'commentCount')
        GROUP BY metricType
      `,
      query_params: { songId },
      format: 'JSONEachRow',
    });
    const rows = await response.json<{ metricType: string; value: string | number }>();
    const of = (type: string) => Number(rows.find((r) => r.metricType === type)?.value ?? 0);
    return { plays: of('Play'), likes: of('Like'), comments: of('commentCount') };
  } catch (error) {
    logAxiomError(error, { name: 'audio-review-song-activity' });
    return null;
  }
}

/** Every browsing level, Blocked included: a removed song or cover is what an appeal is about. */
const ALL_LEVELS = 0x7fffffff;
/** The appeals read at once; past this the oldest are listed. */
const APPEALS_READ = 500;

/**
 * One page of the Appeals tab: owners' Pending appeals of a removed song or a song's removed cover,
 * read through the image Appeals queue's own reader (`getAppealImageQueue`, `songs: 'only'`) and
 * filtered here like the Reported tab, since an appeal withheld from this moderator matches only its
 * exact id. A cover's song is named only when it is not withheld too (`visibleSongLinks`).
 */
export async function getSongAppeals({
  sort,
  filter,
  q,
  page,
  user,
}: {
  sort: AppealSort;
  filter: AppealFilter;
  q: string;
  page: number;
  user: App.Locals['user'] | undefined;
}) {
  const { items } = await getAppealImageQueue({
    browsingLevel: ALL_LEVELS,
    limit: APPEALS_READ,
    csamReview: holdsCsamReview(user),
    songs: 'only',
  });
  const ids = items.map((i) => i.id);
  const [links, songs, counts] = await Promise.all([
    visibleSongLinks(ids, user),
    ids.length
      ? dbRead
          .selectFrom('Image as s')
          .leftJoin('Track as t', 't.imageId', 's.id')
          .leftJoin('Image as c', 'c.id', 't.coverImageId')
          .select([
            's.id',
            'c.id as coverId',
            sql<string | null>`s.metadata->>'title'`.as('title'),
            sql<string | null>`CASE WHEN ${sql.raw(songsOwnCoverText('c', 's'))} AND ${sql.raw(
              playerSongCoverText('c')
            )} THEN c.url END`.as('coverUrl'),
          ])
          .where('s.type', '=', 'audio')
          .where((eb) =>
            eb.or([
              eb('s.id', 'in', ids),
              eb(
                's.id',
                'in',
                eb.selectFrom('Track').select('imageId').where('coverImageId', 'in', ids)
              ),
            ])
          )
          .execute()
      : [],
    ids.length
      ? dbRead
          .selectFrom('Appeal')
          .select(['entityId', sql<number>`count(*)::int`.as('n')])
          .where('entityType', '=', 'Image')
          .where('entityId', 'in', ids)
          .groupBy('entityId')
          .execute()
      : [],
  ]);
  const songById = new Map(songs.map((s) => [s.id, s]));
  const coversWithheld = await withheldCovers(songs, user);
  const appealsOf = new Map(counts.map((c) => [c.entityId, c.n]));
  const rows = items.map((item): SongAppealRow => {
    // From the song read, not `item.type`, which a withheld row no longer carries.
    const kind = songById.has(item.id) ? 'song' : 'cover';
    const base = {
      id: item.id,
      appealId: item.appeal.id,
      kind,
      waitingSince: item.appeal.createdAt,
      appeals: appealsOf.get(item.id) ?? 1,
    } as const;
    if (item.restricted)
      return {
        ...base,
        withheld: true,
        song: null,
        url: null,
        coverUrl: null,
        owner: null,
        message: null,
        removal: null,
        nsfwLevel: null,
      };
    const coverOf = links.get(item.id)?.coverOf ?? null;
    const songId = kind === 'song' ? item.id : coverOf?.songId ?? null;
    const song = songId != null ? songById.get(songId) : undefined;
    return {
      ...base,
      withheld: false,
      song: songId != null ? { id: songId, title: song?.title || null } : null,
      url: item.url,
      coverUrl: song ? shownThumb(song, coversWithheld) : null,
      owner: { id: item.userId, username: item.username },
      message: item.appeal.message || null,
      removal: {
        reason: removalReasonLabel(item.tosReason, item.blockedFor),
        by: item.moderatorUsername,
        at: item.removedAt,
      },
      nsfwLevel: item.nsfwLevel,
    };
  });

  const asId = /^\d+$/.test(q) ? int4Id.safeParse(q) : null;
  const term = q.toLowerCase();
  const searched = !q
    ? rows
    : rows.filter((r) =>
        asId?.success
          ? r.id === asId.data || r.song?.id === asId.data
          : !r.withheld &&
            (!!r.song?.title?.toLowerCase().includes(term) ||
              !!r.owner?.username?.toLowerCase().startsWith(term))
      );
  const facets = {
    all: searched.length,
    song: searched.filter((r) => r.kind === 'song').length,
    cover: searched.filter((r) => r.kind === 'cover').length,
  };
  const filtered = searched.filter((r) => filter === 'all' || r.kind === filter);
  if (sort === 'newest') filtered.reverse();
  const offset = (page - 1) * PAGE_SIZE;
  return {
    items: filtered.slice(offset, offset + PAGE_SIZE),
    hasMore: filtered.length > offset + PAGE_SIZE,
    total: facets[filter],
    facets,
    offset,
    pageSize: PAGE_SIZE,
  };
}

/** Whether `imageId` has an appeal the Appeals tab decides: a song or its own cover, Pending. */
export async function isSongAppeal(imageId: number): Promise<boolean> {
  const row = await songAppealImages()
    .select('i.id')
    .where('i.id', '=', imageId)
    .executeTakeFirst();
  return !!row;
}

/** What holds a song, before the access rule: its kind, since when, and the hold or flagged cover. */
type HeldEntry = { id: number; kind: HeldKind; waitingSince: Date; holdId: number | null };

/** Every held song, one entry each: a lyrics hold first, then the song's own flag, then its cover's.
 *  With `ownerId`, only that owner's songs. */
async function heldEntries(ownerId?: number): Promise<HeldEntry[]> {
  const [holds, songs, covers] = await Promise.all([
    dbRead
      .selectFrom('TextScanHold as h')
      .innerJoin('Image as s', 's.id', 'h.entityId')
      .select([
        'h.entityId as id',
        sql<number>`min(h.id)`.as('holdId'),
        sql<Date>`min(h."createdAt")`.as('waitingSince'),
      ])
      .where('h.entityType', '=', 'TrackLyrics')
      .where('h.label', '=', 'csam')
      .where(sql<boolean>`h.status = 'Pending'`)
      .where('s.type', '=', 'audio')
      .$if(ownerId != null, (qb) => qb.where('s.userId', '=', ownerId!))
      .groupBy('h.entityId')
      .execute(),
    dbRead
      .selectFrom('Image as s')
      .select(['s.id', 's.createdAt as waitingSince'])
      .where(sql<boolean>`${sql.raw(flaggedSongsText('s'))}`)
      .$if(ownerId != null, (qb) => qb.where('s.userId', '=', ownerId!))
      .execute(),
    dbRead
      .selectFrom('Track as t')
      .innerJoin('Image as s', 's.id', 't.imageId')
      .innerJoin('Image as c', 'c.id', 't.coverImageId')
      .select(['s.id', 'c.createdAt as waitingSince'])
      .where(sql<boolean>`${sql.raw(flaggedCoverText('c', 's'))}`)
      .$if(ownerId != null, (qb) => qb.where('s.userId', '=', ownerId!))
      .execute(),
  ]);
  const entries = new Map<number, HeldEntry>();
  const add = (kind: HeldKind, rows: { id: number; waitingSince: Date; holdId?: number }[]) => {
    for (const r of rows)
      if (!entries.has(r.id))
        entries.set(r.id, {
          id: r.id,
          kind,
          waitingSince: new Date(r.waitingSince),
          holdId: r.holdId ?? null,
        });
  };
  add('lyrics', holds);
  add('song', songs);
  add('cover', covers);
  return [...entries.values()];
}

/** A held row with nothing that shows or names its song: a lyrics hold for everyone here, and a
 *  cover or song withheld from this moderator. */
const withheldHeldRow = (entry: HeldEntry): HeldSongRow => ({
  id: entry.id,
  kind: entry.kind,
  withheld: true,
  holdId: entry.holdId,
  waitingSince: entry.waitingSince,
  title: null,
  url: null,
  coverUrl: null,
  cover: null,
  flag: null,
  nsfwLevel: null,
  owner: null,
  removed: false,
  removableCoverId: null,
});

/** The rows of these held entries, one each in their order. A lyrics row reads nothing of its song,
 *  and a song gone since the entries were read carries nothing either. */
async function heldRows(
  entries: HeldEntry[],
  user: App.Locals['user'] | undefined
): Promise<HeldSongRow[]> {
  const open = entries.filter((e) => e.kind !== 'lyrics');
  const ids = open.map((e) => e.id);
  const [songs, links] = ids.length
    ? await Promise.all([
        dbRead
          .selectFrom('Image as s')
          .innerJoin('User as owner', 'owner.id', 's.userId')
          .leftJoin('Track as t', 't.imageId', 's.id')
          .leftJoin('Image as c', 'c.id', 't.coverImageId')
          .select([
            's.id',
            's.url',
            's.nsfwLevel',
            's.ingestion',
            's.needsReview',
            sql<string | null>`s.metadata->>'title'`.as('title'),
            'owner.id as ownerId',
            'owner.username as ownerUsername',
            'c.id as coverId',
            'c.url as coverFile',
            'c.needsReview as coverFlag',
            'c.nsfwLevel as coverNsfwLevel',
            sql<string | null>`CASE WHEN ${sql.raw(songsOwnCoverText('c', 's'))} AND ${sql.raw(
              playerSongCoverText('c')
            )} THEN c.url END`.as('coverUrl'),
          ])
          .where('s.id', 'in', ids)
          .execute(),
        visibleSongLinks(ids, user),
      ])
    : [[], new Map()];
  const byId = new Map(songs.map((s) => [s.id, s]));
  // A cover row is withheld when its song or its flagged cover is: the detail shows both.
  const checked = [
    ...ids,
    ...open.flatMap((e) => {
      const coverId = e.kind === 'cover' ? byId.get(e.id)?.coverId : null;
      return coverId != null ? [coverId] : [];
    }),
  ];
  const withheld = new Set(checked.length ? await withheldImageIds(user, checked) : []);
  return entries.map((entry): HeldSongRow => {
    const song = entry.kind === 'lyrics' ? undefined : byId.get(entry.id);
    if (!song) return withheldHeldRow(entry);
    const flaggedCover =
      entry.kind === 'cover' && song.coverId != null && song.coverFile && song.coverFlag
        ? {
            id: song.coverId,
            url: song.coverFile,
            flag: song.coverFlag,
            nsfwLevel: song.coverNsfwLevel ?? 0,
          }
        : null;
    if (withheld.has(entry.id) || (flaggedCover && withheld.has(flaggedCover.id)))
      return withheldHeldRow(entry);
    return {
      ...withheldHeldRow(entry),
      withheld: false,
      title: song.title || null,
      url: song.url,
      coverUrl: song.coverId != null && withheld.has(song.coverId) ? null : song.coverUrl,
      cover: flaggedCover,
      flag: entry.kind === 'song' ? song.needsReview : null,
      nsfwLevel: song.nsfwLevel,
      owner: { id: song.ownerId, username: song.ownerUsername },
      removed: song.ingestion === 'Blocked',
      removableCoverId: links.get(entry.id)?.songCoverId ?? null,
    };
  });
}

/**
 * One page of the Held tab: songs whose lyrics are under a CSAM text hold, songs whose own cover is
 * flagged for review, and songs flagged themselves, one row per song. Filtered here like the other
 * tabs, since a withheld row (every lyrics hold, and what the access rule withholds) matches only
 * its exact id, never its title or owner, and so is never listed under an owner either.
 */
export async function getHeldSongs({
  sort,
  filter,
  q,
  page,
  user,
  owner,
}: {
  sort: HeldSort;
  filter: HeldFilter;
  q: string;
  page: number;
  user: App.Locals['user'] | undefined;
  owner?: number;
}) {
  const entries = (await heldEntries(owner)).sort(
    (a, b) => a.waitingSince.getTime() - b.waitingSince.getTime() || a.id - b.id
  );
  if (sort === 'newest') entries.reverse();
  const asId = /^\d+$/.test(q) ? int4Id.safeParse(q) : null;
  // Text search and the owner filter read the rows they may match: the open ones.
  const rows = (q && !asId?.success) || owner != null ? await heldRows(entries, user) : null;
  const term = q.toLowerCase();
  const searched = entries.filter((e, i) => {
    if (rows && owner != null && rows[i].withheld) return false;
    if (!q) return true;
    if (asId?.success) return e.id === asId.data;
    const row = rows![i];
    return (
      !row.withheld &&
      (!!row.title?.toLowerCase().includes(term) ||
        !!row.owner?.username?.toLowerCase().startsWith(term))
    );
  });
  const facets = {
    all: searched.length,
    lyrics: searched.filter((e) => e.kind === 'lyrics').length,
    cover: searched.filter((e) => e.kind === 'cover').length,
    song: searched.filter((e) => e.kind === 'song').length,
  };
  const filtered = searched.filter((e) => filter === 'all' || e.kind === filter);
  const offset = (page - 1) * PAGE_SIZE;
  const pageEntries = filtered.slice(offset, offset + PAGE_SIZE);
  const items = rows
    ? pageEntries.map((e) => rows[entries.indexOf(e)])
    : await heldRows(pageEntries, user);
  return {
    items,
    hasMore: filtered.length > offset + PAGE_SIZE,
    total: facets[filter],
    facets,
    offset,
    pageSize: PAGE_SIZE,
  };
}

/** The owner's held songs on the Held tab other than `songId`, as the owner filter lists them for
 *  `user` (no lyrics hold, nothing withheld), by kind: a flagged song, or a song with its cover
 *  flagged. */
async function otherHeldOf(ownerId: number, songId: number, user: App.Locals['user'] | undefined) {
  const entries = (await heldEntries(ownerId)).filter((e) => e.id !== songId);
  const rows = (await heldRows(entries, user)).filter((r) => !r.withheld);
  return {
    songs: rows.filter((r) => r.kind === 'song').length,
    covers: rows.filter((r) => r.kind === 'cover').length,
  };
}

/** Whether song `songId` is held for review itself, with `flag` still its flag (Approve song). */
export async function isFlaggedSong(songId: number, flag: string): Promise<boolean> {
  const row = await dbRead
    .selectFrom('Image as s')
    .select('s.id')
    .where('s.id', '=', songId)
    .where('s.needsReview', '=', flag)
    .where(sql<boolean>`${sql.raw(flaggedSongsText('s'))}`)
    .executeTakeFirst();
  return !!row;
}

/** The song's own cover when it is flagged for review with `flag` (Approve cover), else null. */
export async function flaggedCoverOf(songId: number, flag: string): Promise<number | null> {
  const row = await dbRead
    .selectFrom('Track as t')
    .innerJoin('Image as s', 's.id', 't.imageId')
    .innerJoin('Image as c', 'c.id', 't.coverImageId')
    .select('c.id')
    .where('s.id', '=', songId)
    .where('c.needsReview', '=', flag)
    .where(sql<boolean>`${sql.raw(flaggedCoverText('c', 's'))}`)
    .executeTakeFirst();
  return row?.id ?? null;
}

/** The disputes read at once: past this, the oldest Pending ones, or the newest otherwise. */
const DISPUTES_READ = 500;

/**
 * One page of the Disputes tab: owners' rating disputes on songs (Pending by default; Resolved ones
 * carry their ruling), each with its song, the owner's ask and words, which of the song's disputes
 * it is, and the last ruling on one filed before it. Filtered here like the other tabs, since a
 * dispute on a song withheld from this moderator matches only its exact id (the dispute's or the
 * song's), never its title or owner, and so is never listed under an owner either.
 */
export async function getSongDisputes({
  sort,
  filter,
  status = 'pending',
  q,
  page,
  user,
  owner,
}: {
  sort: DisputeSort;
  filter: DisputeFilter;
  status?: DisputeStatus;
  q: string;
  page: number;
  user: App.Locals['user'] | undefined;
  owner?: number;
}) {
  const disputes = await dbRead
    .selectFrom('RatingReview as rr')
    .innerJoin('User as owner', 'owner.id', 'rr.userId')
    .leftJoin('User as resolver', 'resolver.id', 'rr.resolvedBy')
    .leftJoin('Image as s', (join) =>
      join.onRef('s.id', '=', 'rr.entityId').on('s.type', '=', 'audio')
    )
    .leftJoin('Track as t', 't.imageId', 's.id')
    .leftJoin('Image as c', 'c.id', 't.coverImageId')
    .select([
      'rr.id',
      'rr.entityId as songId',
      'rr.createdAt',
      'rr.status',
      'rr.currentLevel',
      'rr.suggestedLevel',
      'rr.appliedLevel',
      'rr.resolvedAt',
      'rr.userComment',
      'rr.modComment',
      'resolver.username as resolverUsername',
      'owner.id as ownerId',
      'owner.username as ownerUsername',
      's.id as foundId',
      's.url',
      's.nsfwLevel',
      's.ingestion',
      sql<string | null>`s.metadata->>'title'`.as('title'),
      's.scanJobs',
      'c.id as coverId',
      sql<string | null>`CASE WHEN ${sql.raw(songsOwnCoverText('c', 's'))} AND ${sql.raw(
        playerSongCoverText('c')
      )} THEN c.url END`.as('coverUrl'),
    ])
    .where('rr.entityType', '=', SONG_ENTITY_TYPE)
    .$if(status === 'pending', (qb) => qb.where('rr.status', '=', ReportStatus.Pending))
    .$if(status === 'resolved', (qb) => qb.where('rr.status', '<>', ReportStatus.Pending))
    .$if(owner != null, (qb) => qb.where('rr.userId', '=', owner!))
    .orderBy('rr.createdAt', status === 'pending' ? 'asc' : 'desc')
    .orderBy('rr.id', status === 'pending' ? 'asc' : 'desc')
    .limit(DISPUTES_READ)
    .execute();
  if (status !== 'pending') disputes.reverse();

  const songIds = [...new Set(disputes.map((d) => d.songId))];
  const [history, withheldList, coversWithheld] = await Promise.all([
    songIds.length
      ? dbRead
          .selectFrom('RatingReview')
          .select(['id', 'entityId', 'status', 'currentLevel', 'appliedLevel', 'resolvedAt'])
          .where('entityType', '=', SONG_ENTITY_TYPE)
          .where('entityId', 'in', songIds)
          .orderBy('createdAt')
          .orderBy('id')
          .execute()
      : [],
    songIds.length ? withheldImageIds(user, songIds) : [],
    withheldCovers(disputes, user),
  ]);
  const withheld = new Set(withheldList);
  const historyOf = new Map<number, (typeof history)[number][]>();
  for (const h of history) historyOf.set(h.entityId, [...(historyOf.get(h.entityId) ?? []), h]);
  const ruling = (h: {
    status: string;
    currentLevel: number;
    appliedLevel: number | null;
    resolvedAt: Date | null;
  }) => ({
    status: h.status,
    currentLevel: h.currentLevel,
    appliedLevel: h.appliedLevel,
    resolvedAt: h.resolvedAt,
  });

  const rows = disputes.map((d): SongDisputeRow & { asks: 'lower' | 'higher' | null } => {
    const asks: 'lower' | 'higher' | null =
      d.suggestedLevel < d.currentLevel
        ? 'lower'
        : d.suggestedLevel > d.currentLevel
        ? 'higher'
        : null;
    const state: DisputeSongState =
      d.foundId == null || songNeverReviewable(songScanStateOf(d.ingestion ?? '', d.scanJobs))
        ? 'gone'
        : d.ingestion === 'Scanned'
        ? 'reviewed'
        : 'unreviewed';
    const songHistory = historyOf.get(d.songId) ?? [];
    const index = songHistory.findIndex((h) => h.id === d.id);
    const before = songHistory.slice(0, Math.max(index, 0));
    const base = {
      id: d.id,
      songId: d.songId,
      waitingSince: d.createdAt,
      status: String(d.status),
      state,
      disputes: (index === -1 ? songHistory.length : index) + 1,
      asks,
    };
    // Nothing about the song: not its levels (so no ask chip), its scan state, its disputes or rulings.
    if (withheld.has(d.songId))
      return {
        ...base,
        status: d.status === ReportStatus.Pending ? ReportStatus.Pending : 'Resolved',
        asks: null,
        state: null,
        disputes: null,
        withheld: true,
        title: null,
        url: null,
        coverUrl: null,
        owner: null,
        currentLevel: null,
        suggestedLevel: null,
        songLevel: null,
        message: null,
        earlier: null,
        ruling: null,
      };
    const earlier = before.filter((h) => h.status !== ReportStatus.Pending).at(-1);
    return {
      ...base,
      withheld: false,
      title: d.title || null,
      url: d.url,
      coverUrl: shownThumb(d, coversWithheld),
      owner: { id: d.ownerId, username: d.ownerUsername },
      currentLevel: d.currentLevel,
      suggestedLevel: d.suggestedLevel,
      songLevel: d.nsfwLevel,
      message: d.userComment || null,
      earlier: earlier ? ruling(earlier) : null,
      ruling:
        d.status === ReportStatus.Pending
          ? null
          : {
              ...ruling({ ...d, status: String(d.status) }),
              by: d.resolverUsername,
              comment: d.modComment || null,
            },
    };
  });

  const asId = /^\d+$/.test(q) ? int4Id.safeParse(q) : null;
  const term = q.toLowerCase();
  const searched = rows.filter((r) => {
    if (owner != null && r.withheld) return false;
    if (!q) return true;
    return asId?.success
      ? r.id === asId.data || r.songId === asId.data
      : !r.withheld &&
          (!!r.title?.toLowerCase().includes(term) ||
            !!r.owner?.username?.toLowerCase().startsWith(term));
  });
  const facets = {
    all: searched.length,
    lower: searched.filter((r) => r.asks === 'lower').length,
    higher: searched.filter((r) => r.asks === 'higher').length,
  };
  const filtered = searched.filter((r) => filter === 'all' || r.asks === filter);
  if (sort === 'newest') filtered.reverse();
  const offset = (page - 1) * PAGE_SIZE;
  return {
    items: filtered.slice(offset, offset + PAGE_SIZE).map(({ asks: _, ...row }) => row),
    hasMore: filtered.length > offset + PAGE_SIZE,
    total: facets[filter],
    facets,
    offset,
    pageSize: PAGE_SIZE,
  };
}

/** The song of a Pending song dispute, or null when the dispute was decided or is not on a song. */
export async function songOfDispute(reviewId: number): Promise<number | null> {
  const row = await pendingSongDisputes()
    .select('rr.entityId')
    .where('rr.id', '=', reviewId)
    .executeTakeFirst();
  return row?.entityId ?? null;
}
