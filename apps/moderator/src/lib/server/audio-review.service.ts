import { sql } from '@civitai/db/kysely';
import { playerSongCoverText, songsOwnCoverText } from '@civitai/db-queries/profile-picture-clear';
import { storedSongDurationSec } from '@civitai/shared';
import {
  checkState,
  LYRICS_SOURCE_LABELS,
  MANY_REPORTS,
  reportTimeSec,
  type ReportedFilter,
  type ReportedSongRow,
  type ReportedSort,
  type SongDetails,
  type SongReport,
} from '$lib/audio-review';
import { reportDetail, reportReasonLabel } from '$lib/reports';
import { pendingSongReports } from './audio-review-count';
import { dbRead } from './db';
import { escapeLike } from './like';
import { int4Id } from './query';
import { withheldImageIds } from './retracted-media';
import { getActiveStrikes } from './user-lookup.service';

/** Per song: when its oldest report was filed, how many reported it, whether any report has a time. */
const songGroups = () =>
  pendingSongReports()
    .innerJoin('User as owner', 'owner.id', 'i.userId')
    .select([
      'i.id',
      sql<Date>`min(r."createdAt")`.as('waitingSince'),
      sql<number>`sum(1 + coalesce(array_length(r."alsoReportedBy", 1), 0))::int`.as('reportCount'),
      sql<boolean>`bool_or(r.details ? 'timestampSec')`.as('hasTime'),
    ])
    .groupBy('i.id');

function searchPredicate(q: string) {
  if (!q) return null;
  const asId = /^\d+$/.test(q) ? int4Id.safeParse(q) : null;
  if (asId?.success) return sql<boolean>`i.id = ${asId.data}`;
  const like = `%${escapeLike(q)}%`;
  return sql<boolean>`(i.metadata->>'title' ILIKE ${like} OR owner.username ILIKE ${
    escapeLike(q) + '%'
  })`;
}

const PAGE_SIZE = 50;

/** One page of reported songs, the total under the filters, and the chip counts under the search. */
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
  const search = searchPredicate(q);
  const groups = () => {
    const base = songGroups();
    return search ? base.where(search) : base;
  };
  const filtered = sql<boolean>`${
    filter === 'timed'
      ? sql`bool_or(r.details ? 'timestampSec')`
      : filter === 'many'
      ? sql`sum(1 + coalesce(array_length(r."alsoReportedBy", 1), 0)) >= ${MANY_REPORTS}`
      : sql`true`
  }`;
  const order =
    sort === 'most'
      ? sql`"reportCount" DESC, "waitingSince" ASC, id ASC`
      : sort === 'newest'
      ? sql`"waitingSince" DESC, id DESC`
      : sql`"waitingSince" ASC, id ASC`;

  const [pageGroups, facets] = await Promise.all([
    dbRead
      .selectFrom(groups().having(filtered).as('g'))
      .selectAll()
      .orderBy(order)
      .limit(PAGE_SIZE + 1)
      .offset((page - 1) * PAGE_SIZE)
      .execute(),
    dbRead
      .selectFrom(groups().as('g'))
      .select([
        sql<number>`count(*)::int`.as('all'),
        sql<number>`(count(*) FILTER (WHERE "hasTime"))::int`.as('timed'),
        sql<number>`(count(*) FILTER (WHERE "reportCount" >= ${MANY_REPORTS}))::int`.as('many'),
      ])
      .executeTakeFirst(),
  ]);
  const hasMore = pageGroups.length > PAGE_SIZE;
  const items = await getReportedSongRows(
    pageGroups.slice(0, PAGE_SIZE).map((g) => g.id),
    user
  );
  const counts = { all: facets?.all ?? 0, timed: facets?.timed ?? 0, many: facets?.many ?? 0 };
  return {
    items,
    hasMore,
    total: counts[filter],
    facets: counts,
    offset: (page - 1) * PAGE_SIZE,
    pageSize: PAGE_SIZE,
  };
}

/** The rows of these songs with their Pending reports, in the order given. A song withheld from
 *  `user` comes back as `withheldSongRow`. A song with no Pending report left is dropped. */
export async function getReportedSongRows(
  imageIds: number[],
  user: App.Locals['user'] | undefined
): Promise<ReportedSongRow[]> {
  if (!imageIds.length) return [];
  const [songs, reports, withheld] = await Promise.all([
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
        sql<string | null>`s.metadata->>'title'`.as('title'),
        'owner.id as ownerId',
        'owner.username as ownerUsername',
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
    withheldImageIds(user, imageIds),
  ]);
  const withheldSet = new Set(withheld);
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
      coverUrl: song.coverUrl,
      nsfwLevel: song.nsfwLevel,
      ingestion: String(song.ingestion),
      owner: { id: song.ownerId, username: song.ownerUsername },
      waitingSince: songReports[0].createdAt,
      reportCount: songReports.reduce((n, r) => n + 1 + r.also, 0),
      reports: songReports,
    };
    return [withheldSet.has(id) ? withheldSongRow(row) : row];
  });
}

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
    owner: null,
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
 *  not a song. The caller refuses a song withheld from the moderator before calling this. */
export async function getSongDetails(imageId: number): Promise<SongDetails | null> {
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
      't.genre',
      'p.publishedAt',
      'l.source as lyricsSource',
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
  const [model, owner, strikes] = await Promise.all([
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
  ]);
  const otherReported = await pendingSongReports()
    .select(sql<number>`count(DISTINCT i.id)::int`.as('n'))
    .where('i.userId', '=', song.userId)
    .where('i.id', '<>', imageId)
    .executeTakeFirst();

  const cover =
    song.coverId != null
      ? {
          id: song.coverId,
          url: song.coverUrl ?? null,
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
          otherReported: otherReported?.n ?? 0,
        }
      : null,
  };
}
