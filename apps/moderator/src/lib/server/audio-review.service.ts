import { sql } from '@civitai/db/kysely';
import { playerSongCoverText, songsOwnCoverText } from '@civitai/db-queries/profile-picture-clear';
import { storedSongDurationSec } from '@civitai/shared';
import {
  checkState,
  LYRICS_SOURCE_LABELS,
  MANY_REPORTS,
  reportTimeSec,
  removalReasonLabel,
  type AppealFilter,
  type AppealSort,
  type ReportedFilter,
  type SongAppealRow,
  type ReportedSongRow,
  type ReportedSort,
  type SongDetails,
  type SongReport,
} from '$lib/audio-review';
import { reportDetail, reportReasonLabel } from '$lib/reports';
import { pendingSongReports, songAppealImages } from './audio-review-count';
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

/**
 * One page of reported songs, the total under the filters, and the chip counts under the search.
 * Every song with a Pending report is read and filtered here, not in SQL, because what a moderator
 * may search on depends on the media access rule: a song withheld from them matches only its exact
 * id, never its title or owner, and its reports' times count for no chip. The set is the songs
 * with open reports, which stays small.
 */
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
  user: App.Locals['user'] | undefined
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
  const otherReported = await pendingSongReports()
    .select(sql<number>`count(DISTINCT i.id)::int`.as('n'))
    .where('i.userId', '=', song.userId)
    .where('i.id', '<>', imageId)
    .executeTakeFirst();

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

/** Every browsing level, Blocked included: a removed song or cover is what an appeal is about. */
const ALL_LEVELS = 0x7fffffff;
/** The appeals read at once. Songs and covers under appeal stay few, as reported songs do. */
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
  const appealsOf = new Map(counts.map((c) => [c.entityId, c.n]));
  const rows = items.map((item): SongAppealRow => {
    const kind = item.type === 'audio' ? 'song' : 'cover';
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
      coverUrl: song?.coverUrl ?? null,
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
