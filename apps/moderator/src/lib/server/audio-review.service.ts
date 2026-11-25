import { sql } from '@civitai/db/kysely';
import { playerSongCoverText, songsOwnCoverText } from '@civitai/db-queries/profile-picture-clear';
import { storedSongDurationSec } from '@civitai/shared';
import { songNeverReviewable } from '@civitai/shared/rating-review';
import {
  checkState,
  LYRICS_SOURCE_LABELS,
  MANY_REPORTS,
  reportTimeSec,
  removalReasonLabel,
  type AppealFilter,
  type AppealSort,
  type DisputeFilter,
  type DisputeSongState,
  type DisputeSort,
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
/** The appeals read at once. Songs and covers under appeal stay few, as reported songs do; past this
 *  the oldest are listed and the rest wait for them to be decided. */
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

/** Every held song, one entry each: a lyrics hold first, then the song's own flag, then its cover's. */
async function heldEntries(): Promise<HeldEntry[]> {
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
      .groupBy('h.entityId')
      .execute(),
    dbRead
      .selectFrom('Image as s')
      .select(['s.id', 's.createdAt as waitingSince'])
      .where(sql<boolean>`${sql.raw(flaggedSongsText('s'))}`)
      .execute(),
    dbRead
      .selectFrom('Track as t')
      .innerJoin('Image as s', 's.id', 't.imageId')
      .innerJoin('Image as c', 'c.id', 't.coverImageId')
      .select(['s.id', 'c.createdAt as waitingSince'])
      .where(sql<boolean>`${sql.raw(flaggedCoverText('c', 's'))}`)
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
 * its exact id, never its title or owner.
 */
export async function getHeldSongs({
  sort,
  filter,
  q,
  page,
  user,
}: {
  sort: HeldSort;
  filter: HeldFilter;
  q: string;
  page: number;
  user: App.Locals['user'] | undefined;
}) {
  const entries = (await heldEntries()).sort(
    (a, b) => a.waitingSince.getTime() - b.waitingSince.getTime() || a.id - b.id
  );
  if (sort === 'newest') entries.reverse();
  const asId = /^\d+$/.test(q) ? int4Id.safeParse(q) : null;
  // Text search reads the rows it may match: the open ones.
  const rows = q && !asId?.success ? await heldRows(entries, user) : null;
  const searched = !q
    ? entries
    : asId?.success
    ? entries.filter((e) => e.id === asId.data)
    : entries.filter((_, i) => {
        const row = rows![i];
        const term = q.toLowerCase();
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

/** The disputes read at once; past this the oldest are listed and the rest wait, as appeals do. */
const DISPUTES_READ = 500;

/**
 * One page of the Disputes tab: owners' Pending rating disputes on songs, each with its song, the
 * owner's ask and words, and the last ruling on an earlier dispute of the same song. Filtered here
 * like the other tabs, since a dispute on a song withheld from this moderator matches only its exact
 * id (the dispute's or the song's), never its title or owner.
 */
export async function getSongDisputes({
  sort,
  filter,
  q,
  page,
  user,
}: {
  sort: DisputeSort;
  filter: DisputeFilter;
  q: string;
  page: number;
  user: App.Locals['user'] | undefined;
}) {
  const disputes = await pendingSongDisputes()
    .innerJoin('User as owner', 'owner.id', 'rr.userId')
    .leftJoin('Image as s', (join) =>
      join.onRef('s.id', '=', 'rr.entityId').on('s.type', '=', 'audio')
    )
    .leftJoin('Track as t', 't.imageId', 's.id')
    .leftJoin('Image as c', 'c.id', 't.coverImageId')
    .select([
      'rr.id',
      'rr.entityId as songId',
      'rr.createdAt',
      'rr.currentLevel',
      'rr.suggestedLevel',
      'rr.userComment',
      'owner.id as ownerId',
      'owner.username as ownerUsername',
      's.id as foundId',
      's.url',
      's.nsfwLevel',
      's.ingestion',
      sql<string | null>`s.metadata->>'title'`.as('title'),
      // The resolver's own reads of whether the song can still be reviewed (`songNeverReviewable`).
      sql<number | null>`(s."scanJobs"->>'retryCount')::int`.as('retryCount'),
      sql<
        string | null
      >`COALESCE(s."scanJobs"->'error', s."scanJobs"->'lastFailure')->>'failureClass'`.as(
        'failureClass'
      ),
      sql<
        string | null
      >`COALESCE(s."scanJobs"->'error', s."scanJobs"->'lastFailure')->>'reason'`.as(
        'failureReason'
      ),
      'c.id as coverId',
      sql<string | null>`CASE WHEN ${sql.raw(songsOwnCoverText('c', 's'))} AND ${sql.raw(
        playerSongCoverText('c')
      )} THEN c.url END`.as('coverUrl'),
    ])
    .orderBy('rr.createdAt')
    .orderBy('rr.id')
    .limit(DISPUTES_READ)
    .execute();

  const songIds = [...new Set(disputes.map((d) => d.songId))];
  const [history, withheldList, coversWithheld] = await Promise.all([
    songIds.length
      ? dbRead
          .selectFrom('RatingReview')
          .select(['entityId', 'status', 'appliedLevel', 'resolvedAt'])
          .where('entityType', '=', SONG_ENTITY_TYPE)
          .where('entityId', 'in', songIds)
          .where('status', '<>', ReportStatus.Pending)
          .orderBy('createdAt', 'desc')
          .execute()
      : [],
    songIds.length ? withheldImageIds(user, songIds) : [],
    withheldCovers(disputes, user),
  ]);
  const withheld = new Set(withheldList);
  // Newest first, so the first ruling seen per song is its last.
  const earlierOf = new Map<number, (typeof history)[number]>();
  const decidedOf = new Map<number, number>();
  for (const h of history) {
    if (!earlierOf.has(h.entityId)) earlierOf.set(h.entityId, h);
    decidedOf.set(h.entityId, (decidedOf.get(h.entityId) ?? 0) + 1);
  }

  const rows = disputes.map((d): SongDisputeRow & { asks: 'lower' | 'higher' | null } => {
    const asks: 'lower' | 'higher' | null =
      d.suggestedLevel < d.currentLevel
        ? 'lower'
        : d.suggestedLevel > d.currentLevel
        ? 'higher'
        : null;
    const state: DisputeSongState =
      d.foundId == null ||
      songNeverReviewable({
        ingestion: d.ingestion ?? '',
        retryCount: d.retryCount,
        failureClass: d.failureClass,
        failureReason: d.failureReason,
      })
        ? 'gone'
        : d.ingestion === 'Scanned'
        ? 'reviewed'
        : 'unreviewed';
    const base = {
      id: d.id,
      songId: d.songId,
      waitingSince: d.createdAt,
      state,
      disputes: (decidedOf.get(d.songId) ?? 0) + 1,
      asks,
    };
    if (withheld.has(d.songId))
      return {
        ...base,
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
      };
    const earlier = earlierOf.get(d.songId);
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
      earlier: earlier
        ? {
            status: earlier.status,
            appliedLevel: earlier.appliedLevel,
            resolvedAt: earlier.resolvedAt,
          }
        : null,
    };
  });

  const asId = /^\d+$/.test(q) ? int4Id.safeParse(q) : null;
  const term = q.toLowerCase();
  const searched = !q
    ? rows
    : rows.filter((r) =>
        asId?.success
          ? r.id === asId.data || r.songId === asId.data
          : !r.withheld &&
            (!!r.title?.toLowerCase().includes(term) ||
              !!r.owner?.username?.toLowerCase().startsWith(term))
      );
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
