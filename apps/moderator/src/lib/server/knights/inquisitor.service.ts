import type { ExpressionBuilder, Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { sql, utc } from '@civitai/db/kysely';
import { ESCALATED_FROM_LEVEL_META_KEY, gradeKnightsVotes } from '@civitai/db/knights';
import { NsfwLevel } from '@civitai/shared';
import {
  KNIGHTS_ESCALATION_REASONS,
  KNIGHTS_NSFW_LEVEL_QUESTION,
  KNIGHTS_STAGE_RANKS,
  KNIGHTS_WRITEBACK_REASONS,
  type KnightsEscalationReason,
  type KnightsWritebackReason,
} from '@civitai/shared/new-order';
import {
  csamRestrictedSql,
  retractedImageWhereSql,
  siblingsServable,
  urlSiblingsSql,
  type UrlSibling,
} from '@civitai/shared/retracted-media-tier';
import { RETRACTED_MEDIA_READ_TIMEOUT_MS } from '@civitai/shared/retracted-media';
import { blockedForSignal } from '@civitai/shared/review-batch';
import { INQUISITOR_FILTERS, type InquisitorFilter } from '$lib/knights/inquisitor-filters';
import { BLOCKED_RATING_REFUSED } from '$lib/knights/inquisitor-ruling';
import { isRatingLevel } from '$lib/nsfw-levels';
import { logToAxiom } from '../axiom';
import { blockedForPatterns } from '../blocked-for-patterns';
import { dbRead, dbWrite } from '../db';
import { updateImageNsfwLevel } from '../image-nsfw-level';
import {
  consensusBlockReason,
  isKnightsBlockReason,
  knightsBlockReasonLabel,
  type ConsensusBlockReason,
} from './block-reason';

export const INQUISITOR_QUEUE_LIMIT = 100;

export type InquisitorVote = {
  answer: string;
  label: string;
  votes: number;
  weight: number;
  /** Votes for this answer by the stage the item was at when they were cast, lowest stage first; stages with none are left out. A higher rank can vote at a lower stage, so this is not the voter's rank. */
  stages: { stage: string; votes: number }[];
};

export type InquisitorItem = {
  id: number;
  imageId: number;
  imageKey: string;
  imageName: string | null;
  imageType: string;
  prompt: string;
  reason: KnightsWritebackReason | null;
  escalationReason: KnightsEscalationReason | null;
  source: string;
  currentLevel: number;
  /** The image's level when the item reached the Inquisitors; null on items escalated before it was recorded. */
  escalatedFromLevel: number | null;
  locked: boolean;
  hasBlockMarker: boolean;
  blockedFor: string | null;
  /** Where the page may draw the image from: the public CDN, `/api/retracted-media`, or nowhere. */
  media: InquisitorMedia;
  createdAt: Date;
  votes: InquisitorVote[];
  blockReason: ConsensusBlockReason | null;
};

export type InquisitorMedia = 'cdn' | 'retracted' | 'restricted';

type QuestionOption = { value: string; label: string };

const parseOptions = (value: unknown): QuestionOption[] =>
  Array.isArray(value)
    ? value.filter(
        (option): option is QuestionOption =>
          !!option && typeof option.value === 'string' && typeof option.label === 'string'
      )
    : [];

const narrow = <T extends string>(values: readonly T[], value: string | null): T | null =>
  values.find((candidate) => candidate === value) ?? null;

const hasBlockMarker = (image: { ingestion: string; blockedFor: string | null }) =>
  image.ingestion === 'Blocked' || image.blockedFor !== null;

/** Shared by the page and the sidebar badge, so a filter added here applies to both. The badge is uncapped; the page shows at most INQUISITOR_QUEUE_LIMIT. */
const waitingOnInquisitors = (db: Kysely<DB>) =>
  db
    .selectFrom('KnightsQueueItem as i')
    .innerJoin('KnightsQuestion as q', 'q.key', 'i.questionKey')
    .innerJoin('Image as img', 'img.id', 'i.imageId')
    .where('i.status', '=', 'Inquisitor')
    .where('i.questionKey', '=', KNIGHTS_NSFW_LEVEL_QUESTION);

type QueueItemBuilder = ExpressionBuilder<DB & { i: DB['KnightsQueueItem'] }, 'i'>;

const filterCondition = (eb: QueueItemBuilder, filter: Exclude<InquisitorFilter, 'all'>) =>
  filter === 'write-back' ? eb('i.reason', 'is not', null) : eb('i.escalationReason', '=', filter);

export type InquisitorFilterCounts = Record<InquisitorFilter, number>;

/**
 * One scan over the same base query as the list, so a tab's count is what clicking it shows. Reads the
 * primary like the list; the sidebar badge reads the replica, so the two can differ by replica lag.
 */
export async function countInquisitorQueueByFilter(): Promise<InquisitorFilterCounts> {
  const row = await waitingOnInquisitors(dbWrite)
    .select((eb) =>
      INQUISITOR_FILTERS.map((filter) =>
        filter === 'all'
          ? eb.fn.countAll<string>().as(filter)
          : eb.fn.countAll<string>().filterWhere(filterCondition(eb, filter)).as(filter)
      )
    )
    .executeTakeFirst();
  return Object.fromEntries(
    INQUISITOR_FILTERS.map((filter) => [filter, Number(row?.[filter] ?? 0)])
  ) as InquisitorFilterCounts;
}

export async function countInquisitorQueue(): Promise<number> {
  const row = await waitingOnInquisitors(dbRead)
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

type StageTally = { answer: string; stage: string; votes: string; weight: number };

const stageOrder = (stage: string) => {
  const index = (KNIGHTS_STAGE_RANKS as readonly string[]).indexOf(stage);
  return index === -1 ? KNIGHTS_STAGE_RANKS.length : index;
};

function tallyByAnswer(tallies: StageTally[], labels: Map<string, string>): InquisitorVote[] {
  const byAnswer = new Map<string, InquisitorVote>();
  for (const tally of tallies) {
    const vote = byAnswer.get(tally.answer) ?? {
      answer: tally.answer,
      label: labels.get(tally.answer) ?? tally.answer,
      votes: 0,
      weight: 0,
      stages: [],
    };
    vote.votes += Number(tally.votes);
    vote.weight += Number(tally.weight);
    vote.stages.push({ stage: tally.stage, votes: Number(tally.votes) });
    byAnswer.set(tally.answer, vote);
  }
  return [...byAnswer.values()]
    .map((vote) => ({
      ...vote,
      stages: vote.stages.sort((a, b) => stageOrder(a.stage) - stageOrder(b.stage)),
    }))
    .sort((a, b) => b.weight - a.weight || a.answer.localeCompare(b.answer));
}

export async function getInquisitorQueue(
  filter: InquisitorFilter = 'all'
): Promise<InquisitorItem[]> {
  const base = waitingOnInquisitors(dbWrite);
  const items = await (filter === 'all' ? base : base.where((eb) => filterCondition(eb, filter)))
    .select([
      'i.id',
      'i.imageId',
      'i.reason',
      'i.escalationReason',
      'i.source',
      'i.createdAt',
      'q.prompt',
      'q.options',
      'img.url as imageKey',
      'img.name as imageName',
      'img.type as imageType',
      'img.nsfwLevel as currentLevel',
      'img.nsfwLevelLocked as locked',
      'img.ingestion',
      'img.blockedFor',
      sql<number | null>`(i.meta ->> ${sql.lit(ESCALATED_FROM_LEVEL_META_KEY)})::int`.as(
        'escalatedFromLevel'
      ),
    ])
    .orderBy('i.priority', 'asc')
    .orderBy('i.createdAt', 'asc')
    .orderBy('i.id', 'asc')
    .limit(INQUISITOR_QUEUE_LIMIT)
    .execute();
  if (items.length === 0) return [];

  const tallies = await dbWrite
    .selectFrom('KnightsVote')
    .select([
      'itemId',
      'answer',
      'stage',
      sql<string>`count(*)`.as('votes'),
      sql<number>`sum("weight")`.as('weight'),
    ])
    .where(
      'itemId',
      'in',
      items.map((item) => item.id)
    )
    // A held player's vote (weight 0) decided nothing, so it is not shown as a vote.
    .where('weight', '>', 0)
    .groupBy(['itemId', 'answer', 'stage'])
    .execute();

  const blockedVotes = await dbWrite
    .selectFrom('KnightsVote')
    .select(['itemId', 'answer', 'blockReason', 'createdAt', 'playerId'])
    .where(
      'itemId',
      'in',
      items.map((item) => item.id)
    )
    .where('answer', '=', String(NsfwLevel.Blocked))
    .where('weight', '>', 0)
    .execute();

  const viewable = await blockedImagesAnyModeratorMaySee(
    items.filter((item) => item.ingestion === 'Blocked').map((item) => item.imageId)
  );

  return items.map(({ options, ingestion, reason, escalationReason, ...item }) => {
    const media: InquisitorMedia =
      ingestion !== 'Blocked' ? 'cdn' : viewable.has(item.imageId) ? 'retracted' : 'restricted';
    const labels = new Map(parseOptions(options).map((option) => [option.value, option.label]));
    return {
      ...item,
      reason: narrow(KNIGHTS_WRITEBACK_REASONS, reason),
      escalationReason: narrow(KNIGHTS_ESCALATION_REASONS, escalationReason),
      hasBlockMarker: hasBlockMarker({ ingestion, blockedFor: item.blockedFor }),
      media,
      // The page draws a restricted image from nowhere, so it gets no storage key either.
      imageKey: media === 'restricted' ? '' : item.imageKey,
      blockReason: consensusBlockReason(blockedVotes.filter((vote) => vote.itemId === item.id)),
      votes: tallyByAnswer(
        tallies.filter((tally) => tally.itemId === item.id),
        labels
      ),
    };
  });
}

/**
 * The blocked images `/api/retracted-media` may serve to a moderator without the CSAM page's grant.
 * Must mirror that route's Postgres checks (`getRetractedMedia`); the rest are drawn as restricted.
 */
async function blockedImagesAnyModeratorMaySee(imageIds: number[]): Promise<Set<number>> {
  if (imageIds.length === 0) return new Set();
  try {
    return await readViewable(imageIds);
  } catch (e) {
    // Every blocked row is restricted rather than the whole queue failing to load.
    void logToAxiom({
      name: 'inquisitor-media-read-failed',
      type: 'error',
      payload: { message: e instanceof Error ? e.message : String(e) },
    });
    return new Set();
  }
}

async function readViewable(imageIds: number[]): Promise<Set<number>> {
  const rows = await dbWrite.transaction().execute(async (trx) => {
    await sql.raw(`SET LOCAL statement_timeout = ${RETRACTED_MEDIA_READ_TIMEOUT_MS}`).execute(trx);
    return trx
      .selectFrom('Image as i')
      .select(['i.id', 'i.blockedFor'])
      .select(sql<UrlSibling[]>`${sql.raw(urlSiblingsSql('i'))}`.as('siblings'))
      .where('i.id', 'in', imageIds)
      .where(sql<boolean>`${sql.raw(retractedImageWhereSql('i'))}`)
      .where(sql<boolean>`NOT ${sql.raw(csamRestrictedSql('i'))}`)
      .execute();
  });
  const patterns = blockedForPatterns();
  const isSignal = (blockedFor: string | null) => blockedForSignal(blockedFor, patterns);
  const viewable = new Set<number>();
  for (const row of rows)
    if (!isSignal(row.blockedFor) && (await siblingsServable(row.siblings, isSignal)))
      viewable.add(row.id);
  return viewable;
}

export type RulingOutcome = { ok: true } | { ok: false; error: string };

const GONE = 'This item has already been decided. Reload the page.';
const IN_PROGRESS = 'Another moderator is deciding this item right now. Reload the page.';
const TAKEN_OVER =
  'The rating was applied, but the item is now being decided by another moderator. Reload the page.';
const NOT_CLOSED =
  'The rating was applied but the item was not closed; reload and rule again with the same level.';

/** Must outlast the rating write, or a live ruling can be reclaimed. */
export const RULING_LEASE_MS = 10 * 60_000;

async function claim(itemId: number, moderatorId: number, now: Date) {
  return dbWrite
    .updateTable('KnightsQueueItem')
    .set({
      status: 'Ruling',
      resolvedBy: moderatorId,
      nextAttemptAt: utc(new Date(now.getTime() + RULING_LEASE_MS)),
      updatedAt: utc(now),
    })
    .where('id', '=', itemId)
    .where('questionKey', '=', KNIGHTS_NSFW_LEVEL_QUESTION)
    .where((eb) =>
      eb.or([
        eb('status', '=', 'Inquisitor'),
        eb.and([eb('status', '=', 'Ruling'), eb('nextAttemptAt', '<=', utc(now))]),
      ])
    )
    .returning('imageId')
    .executeTakeFirst();
}

async function release(itemId: number, moderatorId: number, now: Date) {
  await dbWrite
    .updateTable('KnightsQueueItem')
    .set({ status: 'Inquisitor', resolvedBy: null, nextAttemptAt: null, updatedAt: utc(now) })
    .where('id', '=', itemId)
    .where('status', '=', 'Ruling')
    .where('resolvedBy', '=', moderatorId)
    .execute();
}

export type InquisitorRuling = { level: number; blockReason?: string | null };

/** Why a ruling cannot be recorded, or null: Blocked needs a reason from the Knights list, as a Knight's Blocked vote does, and any other level carries none. */
export function rulingProblem({ level, blockReason }: InquisitorRuling): string | null {
  if (!isRatingLevel(level)) return 'Pick a rating.';
  const given = blockReason !== null && blockReason !== undefined && blockReason !== '';
  if (level === NsfwLevel.Blocked) {
    if (!given) return 'Pick a reason for blocking.';
    return isKnightsBlockReason(blockReason) ? null : 'That block reason is not on the list.';
  }
  return given ? 'Only a Blocked ruling takes a block reason.' : null;
}

export async function ruleOnInquisitorItem(
  itemId: number,
  ruling: InquisitorRuling,
  moderatorId: number,
  now: Date = new Date()
): Promise<RulingOutcome> {
  const problem = rulingProblem(ruling);
  if (problem) return { ok: false, error: problem };
  const { level } = ruling;
  // Written where every moderator rating records why it was set; other levels leave it empty, as before.
  const reason =
    level === NsfwLevel.Blocked && isKnightsBlockReason(ruling.blockReason)
      ? `Inquisitor ruling: ${knightsBlockReasonLabel(ruling.blockReason)}`
      : undefined;

  const claimed = await claim(itemId, moderatorId, now);
  if (!claimed) {
    const current = await dbWrite
      .selectFrom('KnightsQueueItem')
      .select('status')
      .where('id', '=', itemId)
      .executeTakeFirst();
    return { ok: false, error: current?.status === 'Ruling' ? IN_PROGRESS : GONE };
  }

  try {
    const image = await dbWrite
      .selectFrom('Image')
      .select(['ingestion', 'blockedFor'])
      .where('id', '=', claimed.imageId)
      .executeTakeFirst();
    if (image && hasBlockMarker(image) && level !== NsfwLevel.Blocked) {
      await release(itemId, moderatorId, now);
      return { ok: false, error: BLOCKED_RATING_REFUSED };
    }

    await updateImageNsfwLevel({
      id: claimed.imageId,
      nsfwLevel: level,
      ...(reason && { reason }),
      userId: moderatorId,
    });
  } catch (error) {
    await release(itemId, moderatorId, now).catch(() => undefined);
    throw error;
  }

  try {
    const closed = await dbWrite.transaction().execute(async (tx) => {
      const row = await tx
        .updateTable('KnightsQueueItem')
        .set({
          status: 'Closed',
          resolvedValue: String(level),
          resolvedAt: utc(now),
          resolvedBy: moderatorId,
          appliedAt: utc(now),
          nextAttemptAt: null,
          reason: 'moderator-ruled',
          updatedAt: utc(now),
        })
        .where('id', '=', itemId)
        .where('status', '=', 'Ruling')
        .where('resolvedBy', '=', moderatorId)
        .returning('id')
        .executeTakeFirst();
      if (!row) return false;

      await gradeKnightsVotes(tx, itemId, String(level));
      return true;
    });
    if (closed) return { ok: true };
    const current = await dbWrite
      .selectFrom('KnightsQueueItem')
      .select('status')
      .where('id', '=', itemId)
      .executeTakeFirst();
    return { ok: false, error: current?.status === 'Ruling' ? TAKEN_OVER : GONE };
  } catch (error) {
    console.error('knights inquisitor: the rating was set but the item could not be closed', {
      itemId,
      error,
    });
    await release(itemId, moderatorId, now).catch(() => undefined);
    return { ok: false, error: NOT_CLOSED };
  }
}
