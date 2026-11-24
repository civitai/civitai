import { sql, type Kysely, type SqlBool } from 'kysely';
import {
  mergeMeta,
  MOD_TAG_REVIEW_AXIS,
  MOD_TAG_REVIEW_SOURCE,
  modReviewEligibleImage,
  servableImage,
} from '@civitai/db/knights';
import type { DB } from '@civitai/db-schema/kysely';
import { NsfwLevel } from '@civitai/shared';
import { staffedRanks } from '../queue/queue.service';
import { importYesNo, type YesNoRow } from './import';
import { YESNO_AUDIENCE } from './keys';

/** The stage tag review items are judged at; they start there and never move. */
export const TAG_REVIEW_RANK = 'Paladin';
/** Set on an item once its tag stopped being flagged (a ruling, either side): a re-flag then opens the next episode. */
export const EPISODE_ENDED_META_KEY = 'episodeEnded';

export type TagReviewMeta = { tagId?: unknown; episode?: unknown; episodeEnded?: unknown };

export const tagIdOf = (meta: unknown): number | null => {
  const tagId = (meta as TagReviewMeta | null)?.tagId;
  return typeof tagId === 'number' && Number.isInteger(tagId) ? tagId : null;
};

/** In the moderator tag review queue: needsReview (bit 9) set, disabled (bit 10) clear, written as the moderator queue's partial indexes are. */
const flaggedSql = (alias: string) =>
  sql<SqlBool>`(((${sql.ref(`${alias}.attributes`)} >> 9)::integer & 1) = 1) AND (((${sql.ref(
    `${alias}.attributes`
  )} >> 10)::integer & 1) <> 1)`;

/** Where the creation walk resumes: kept in process memory, so a restart only starts the walk over. */
export type TagReviewWalk = { after: { imageId: number; tagId: number } | null };
export const tagReviewWalk: TagReviewWalk = { after: null };

export type TagReviewResult = {
  /** New items (a first episode, or the next one after a ruling). */
  created: number;
  /** Open items closed `moderator-ruled` because their tag stopped being flagged. */
  ruled: number;
  /** Finished items stamped as ending their episode. */
  ended: number;
  failed: number;
};

/**
 * One tick of the moderator tag review source.
 *
 * First, every item not yet ended whose tag is no longer flagged (a moderator ruled, or the tag was disabled or
 * removed) ends its episode: an Open one is closed `moderator-ruled` (its votes inconclusive), a finished one is only
 * stamped. This runs with the switch off too.
 *
 * Then, with the switch on and a staffed Paladin stage, the flagged rows are walked by (imageId, tagId), a page at a
 * time within a budget, resuming where the last run stopped. A row whose tag is a Moderation tag below Blocked and
 * whose image may be shown to players (`servableImage`, `modReviewEligibleImage`) gets an item: episode 1, or the next
 * episode once the latest one ended. Anything else (an Open item, a consensus awaiting write-back, a close that never
 * saw the flag clear) creates nothing, so a pair never has two Open items and the tag stays with moderators.
 */
export async function runTagReview(
  db: Kysely<DB>,
  {
    now,
    enabled,
    walk = tagReviewWalk,
    pageSize = 500,
    pagesPerRun = Number.POSITIVE_INFINITY,
    budgetMs = 20_000,
    endLimit = 200,
  }: {
    now: Date;
    enabled: boolean;
    walk?: TagReviewWalk;
    pageSize?: number;
    pagesPerRun?: number;
    budgetMs?: number;
    endLimit?: number;
  }
): Promise<TagReviewResult> {
  const result: TagReviewResult = { created: 0, ruled: 0, ended: 0, failed: 0 };
  await endEpisodes(db, now, endLimit, result);
  if (!enabled || !(await staffedRanks(db, now)).has(TAG_REVIEW_RANK)) return result;

  const deadline = Date.now() + budgetMs;
  for (let pages = 0; pages < pagesPerRun && Date.now() < deadline; pages++) {
    const from = walk.after ?? { imageId: 0, tagId: 0 };
    // The flagged rows come from the `TagsOnImageNew_needsReview_idx` partial index alone (its predicate copied exactly
    // in `flaggedSql`), materialized before any join: joining Tag or Image inside that scan makes Postgres walk the
    // whole table instead (over a minute on prod). The same rule is noted on the moderator queue query.
    const page = await db
      .with(
        (cte) => cte('flagged').materialized(),
        (qb) =>
          qb
            .selectFrom('TagsOnImageNew as f')
            .select(['f.imageId', 'f.tagId'])
            .where(flaggedSql('f'))
      )
      .selectFrom('flagged as t')
      .innerJoin('Image as img', 'img.id', 't.imageId')
      .innerJoin('Post as p', 'p.id', 'img.postId')
      .innerJoin('Tag as tag', 'tag.id', 't.tagId')
      .select(['t.imageId', 't.tagId', 'tag.name'])
      .where('tag.type', '=', 'Moderation')
      .where('tag.nsfwLevel', '<', NsfwLevel.Blocked)
      .where(servableImage)
      .where(modReviewEligibleImage)
      .where(sql<SqlBool>`(t."imageId", t."tagId") > (${from.imageId}, ${from.tagId})`)
      .orderBy('t.imageId', 'asc')
      .orderBy('t.tagId', 'asc')
      .limit(pageSize)
      .execute();
    if (page.length > 0) result.created += await createEpisodes(db, page, now);
    // Advanced only after the page's items exist, so a failed create retries this page next run.
    const last = page.at(-1);
    walk.after =
      page.length < pageSize || !last ? null : { imageId: last.imageId, tagId: last.tagId };
    if (!walk.after) break;
  }
  return result;
}

async function createEpisodes(
  db: Kysely<DB>,
  page: { imageId: number; tagId: number; name: string }[],
  now: Date
): Promise<number> {
  const existing = await db
    .selectFrom('KnightsQueueItem')
    .select(['imageId', 'meta'])
    .where('source', '=', MOD_TAG_REVIEW_SOURCE)
    .where('imageId', 'in', [...new Set(page.map((r) => r.imageId))])
    .execute();
  const latest = new Map<string, TagReviewMeta>();
  for (const item of existing) {
    const meta = (item.meta ?? {}) as TagReviewMeta;
    const key = `${item.imageId}:${String(meta.tagId)}`;
    const held = latest.get(key);
    if (!held || Number(meta.episode) > Number(held.episode)) latest.set(key, meta);
  }

  const rows: YesNoRow[] = [];
  for (const { imageId, tagId, name } of page) {
    const before = latest.get(`${imageId}:${tagId}`);
    if (before && before[EPISODE_ENDED_META_KEY] !== true) continue;
    const episode = before ? Number(before.episode) + 1 : 1;
    if (!Number.isInteger(episode) || episode < 1) continue;
    rows.push({
      externalId: `mod-tag:${imageId}:${tagId}:${episode}`,
      imageId,
      axis: MOD_TAG_REVIEW_AXIS,
      audience: YESNO_AUDIENCE.players,
      prompt: `Should this image have the tag ${name}?`,
      yesEffect: null,
      noEffect: null,
      meta: { tagId, episode },
    });
  }
  if (rows.length === 0) return 0;
  const imported = await importYesNo(db, rows, {
    source: MOD_TAG_REVIEW_SOURCE,
    minRank: TAG_REVIEW_RANK,
    now,
  });
  return imported.inserted;
}

async function endEpisodes(db: Kysely<DB>, now: Date, limit: number, result: TagReviewResult) {
  // Knights' database role may not read the tag tables yet (they are granted when the source is switched on), and a query
  // naming one fails before it reads any row. So they are read only once an item is waiting to end.
  const waiting = await db
    .selectFrom('KnightsQueueItem as i')
    .select('i.id')
    .where('i.status', 'in', ['Open', 'Consensus', 'Closed'])
    .where('i.minRank', '=', TAG_REVIEW_RANK)
    .where('i.source', '=', MOD_TAG_REVIEW_SOURCE)
    .where(sql<SqlBool>`NOT COALESCE(i.meta ? ${sql.lit(EPISODE_ENDED_META_KEY)}, false)`)
    .limit(1)
    .executeTakeFirst();
  if (!waiting) return;

  const done = await db
    .selectFrom('KnightsQueueItem as i')
    .select(['i.id', 'i.status', 'i.externalId'])
    .where('i.status', 'in', ['Open', 'Consensus', 'Closed'])
    .where('i.minRank', '=', TAG_REVIEW_RANK)
    .where('i.audience', '=', YESNO_AUDIENCE.players)
    .where('i.source', '=', MOD_TAG_REVIEW_SOURCE)
    .where(sql<SqlBool>`NOT COALESCE(i.meta ? ${sql.lit(EPISODE_ENDED_META_KEY)}, false)`)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('TagsOnImageNew as t')
            .select(sql<number>`1`.as('one'))
            .whereRef('t.imageId', '=', 'i.imageId')
            .where(sql<SqlBool>`t."tagId" = (i.meta ->> 'tagId')::int`)
            .where(flaggedSql('t'))
        )
      )
    )
    .orderBy('i.id', 'asc')
    .limit(limit)
    .execute();

  for (const item of done) {
    try {
      if (item.status === 'Open' && item.externalId) {
        const closed = await importYesNo(db, [], {
          retire: [item.externalId],
          retireReason: 'moderator-ruled',
          retireMeta: { [EPISODE_ENDED_META_KEY]: true },
          now,
        });
        result.ruled += closed.retired;
      } else if (item.status !== 'Open') {
        const stamped = await db
          .updateTable('KnightsQueueItem')
          .set({ meta: mergeMeta({ [EPISODE_ENDED_META_KEY]: true }) })
          .where('id', '=', item.id)
          .where('status', '<>', 'Open')
          .executeTakeFirst();
        result.ended += Number(stamped.numUpdatedRows);
      }
    } catch (error) {
      result.failed++;
      console.error('knights: could not end a tag review episode, it will be retried', {
        itemId: item.id,
        error,
      });
    }
  }
}
