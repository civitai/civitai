import { sql, type Kysely, type SqlBool } from 'kysely';
import { closeOpenYesNoItem } from './close';
import type { DB } from '@civitai/db-schema/kysely';
import {
  axisKey,
  isAxis,
  YESNO_ANSWERS,
  YESNO_AUDIENCE,
  YESNO_CONSENSUS_VOTES,
  YESNO_MAX_VOTES,
  YESNO_SOURCE,
} from './keys';

export type YesNoRow = {
  externalId: string;
  imageId: number;
  axis: string;
  audience: string;
  prompt: string;
  yesEffect: string | null;
  noEffect: string | null;
  meta: Record<string, string>;
};

export type Skipped = Partial<
  Record<
    'inactive' | 'bad-id' | 'bad-image' | 'bad-axis' | 'bad-kind' | 'bad-question' | 'duplicate',
    number
  >
>;

const MAX_ID = 200;
const MAX_QUESTION = 600;
const MAX_EFFECT = 40;
const META_COLUMNS = {
  caseId: 'case_id',
  kind: 'kind',
  purpose: 'source_purpose',
  batchId: 'source_batch_id',
  promotionStatus: 'promotion_status',
  policySha256: 'policy_sha256',
} as const;

const AUDIENCE_OF_KIND: Record<string, string> = {
  observable: YESNO_AUDIENCE.players,
  policy_preference: YESNO_AUDIENCE.moderators,
};

/** Written by the database so a script run on a laptop and one run on a server agree. tsx cannot import the `utc` helper from the workspace package. */
const utcNow = sql<Date>`(now() AT TIME ZONE 'utc')`;

/** An item the import closed as withdrawn. */
const retired = sql<SqlBool>`("KnightsQueueItem"."status" = 'Closed' AND "KnightsQueueItem"."reason" = 'retired')`;

const clip = (value: string | undefined, max: number) => (value ?? '').trim().slice(0, max);

/** Keeps the active candidates and checks each one; a row that fails is counted by reason, never echoed. */
export function toYesNoRows(records: Record<string, string>[]): {
  rows: YesNoRow[];
  skipped: Skipped;
  /** Ids of rows the producer no longer marks active; an open question with one of these is retired by the import. */
  retire: string[];
} {
  const retire: string[] = [];
  const skipped: Skipped = {};
  const skip = (reason: keyof Skipped) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  const seen = new Set<string>();
  const rows: YesNoRow[] = [];

  for (const r of records) {
    if ((r.active_candidate ?? '').trim().toLowerCase() !== 'true') {
      const id = clip(r.question_id, MAX_ID);
      if (id) retire.push(id);
      skip('inactive');
      continue;
    }
    const externalId = clip(r.question_id, MAX_ID);
    if (!externalId) {
      skip('bad-id');
      continue;
    }
    if (seen.has(externalId)) {
      skip('duplicate');
      continue;
    }
    const imageId = Number(r.image_id);
    if (!Number.isSafeInteger(imageId) || imageId <= 0) {
      skip('bad-image');
      continue;
    }
    const axis = clip(r.axis, 60).toLowerCase();
    if (!isAxis(axis)) {
      skip('bad-axis');
      continue;
    }
    const audience = AUDIENCE_OF_KIND[clip(r.kind, 40)];
    if (!audience) {
      skip('bad-kind');
      continue;
    }
    const prompt = clip(r.question, MAX_QUESTION);
    if (!prompt) {
      skip('bad-question');
      continue;
    }
    seen.add(externalId);
    rows.push({
      externalId,
      imageId,
      axis,
      audience,
      prompt,
      yesEffect: clip(r.yes_effect, MAX_EFFECT) || null,
      noEffect: clip(r.no_effect, MAX_EFFECT) || null,
      meta: Object.fromEntries(
        Object.entries(META_COLUMNS).map(([name, column]) => [name, clip(r[column], 120)])
      ),
    });
  }
  return { rows, skipped, retire };
}

export type ImportResult = {
  inserted: number;
  /** Rows that already existed, had no answers yet, and differed. */
  updated: number;
  unchanged: number;
  /** Differ from what is stored but already have answers, so were left as they are. */
  refused: number;
  /** Open questions the producer withdrew, closed with no outcome. */
  retired: number;
  axes: number;
};

/**
 * Upserts questions by their producer id. An item that already has answers is never touched, so a re-import cannot change
 * what a recorded answer was an answer to. The axis questions are created once and never overwritten (their consensus size is tuned in the table).
 */
export async function importYesNo(
  db: Kysely<DB>,
  rows: YesNoRow[],
  {
    batchSize = 1000,
    retire = [],
    now = new Date(),
  }: { batchSize?: number; retire?: string[]; now?: Date } = {}
): Promise<ImportResult> {
  const axes = [...new Set(rows.map((r) => r.axis))];
  for (const axis of axes) {
    await db
      .insertInto('KnightsQuestion')
      .values({
        key: axisKey(axis),
        kind: 'bool',
        prompt: 'Answer the question about this image.',
        options: JSON.stringify(YESNO_ANSWERS),
        minRank: 'Knight',
        votesToResolve: YESNO_CONSENSUS_VOTES,
        maxVotes: YESNO_MAX_VOTES,
        threshold: 0.5,
      })
      .onConflict((oc) => oc.column('key').doNothing())
      .execute();
  }

  const result: ImportResult = {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    refused: 0,
    retired: 0,
    axes: axes.length,
  };
  for (let at = 0; at < rows.length; at += batchSize) {
    const batch = rows.slice(at, at + batchSize);
    const written = await db
      .insertInto('KnightsQueueItem')
      .values(
        batch.map((r) => ({
          externalId: r.externalId,
          questionKey: axisKey(r.axis),
          imageId: r.imageId,
          source: YESNO_SOURCE,
          minRank: 'Knight',
          votesNeeded: YESNO_CONSENSUS_VOTES,
          priority: 2,
          expiresAt: null,
          audience: r.audience,
          prompt: r.prompt,
          yesEffect: r.yesEffect,
          noEffect: r.noEffect,
          meta: JSON.stringify(r.meta),
          createdAt: utcNow,
          updatedAt: utcNow,
        }))
      )
      .onConflict((oc) =>
        oc
          .column('externalId')
          .doUpdateSet((eb) => ({
            questionKey: eb.ref('excluded.questionKey'),
            imageId: eb.ref('excluded.imageId'),
            audience: eb.ref('excluded.audience'),
            prompt: eb.ref('excluded.prompt'),
            yesEffect: eb.ref('excluded.yesEffect'),
            noEffect: eb.ref('excluded.noEffect'),
            meta: eb.ref('excluded.meta'),
            updatedAt: eb.ref('excluded.updatedAt'),
            // A question the file withdrew and now lists again, with no answers, is open again.
            status: sql<string>`CASE WHEN ${retired} THEN 'Open' ELSE "KnightsQueueItem"."status" END`,
            reason: sql<
              string | null
            >`CASE WHEN ${retired} THEN NULL ELSE "KnightsQueueItem"."reason" END`,
            resolvedAt: sql<Date | null>`CASE WHEN ${retired} THEN NULL ELSE "KnightsQueueItem"."resolvedAt" END`,
          }))
          .where(
            sql<SqlBool>`"KnightsQueueItem"."voteCount" = 0 AND (${retired} OR
              ("KnightsQueueItem"."questionKey", "KnightsQueueItem"."imageId", "KnightsQueueItem"."audience", "KnightsQueueItem"."prompt",
               "KnightsQueueItem"."yesEffect", "KnightsQueueItem"."noEffect", "KnightsQueueItem"."meta")
              IS DISTINCT FROM
              (excluded."questionKey", excluded."imageId", excluded."audience", excluded."prompt",
               excluded."yesEffect", excluded."noEffect", excluded."meta")
            )`
          )
      )
      .returning(sql<boolean>`(xmax = 0)`.as('inserted'))
      .execute();
    const inserted = written.filter((w) => w.inserted).length;
    result.inserted += inserted;
    result.updated += written.length - inserted;
    const skipped = batch.length - written.length;
    const refused = skipped > 0 ? await countRefused(db, batch) : 0;
    result.refused += refused;
    result.unchanged += skipped - refused;
  }
  await retireWithdrawn(db, retire, result, now, batchSize);
  return result;
}

const sameMeta = (a: unknown, b: Record<string, string>) =>
  JSON.stringify(Object.entries((a ?? {}) as Record<string, string>).sort()) ===
  JSON.stringify(Object.entries(b).sort());

/** Rows the upsert left alone because they have answers: those that still differ from the file are refused, the rest unchanged. */
async function countRefused(db: Kysely<DB>, batch: YesNoRow[]): Promise<number> {
  const stored = await db
    .selectFrom('KnightsQueueItem')
    .select([
      'externalId',
      'questionKey',
      'imageId',
      'audience',
      'prompt',
      'yesEffect',
      'noEffect',
      'meta',
    ])
    .where('voteCount', '>', 0)
    .where(
      'externalId',
      'in',
      batch.map((r) => r.externalId)
    )
    .execute();
  const byId = new Map(stored.map((s) => [s.externalId, s]));
  return batch.filter((r) => {
    const s = byId.get(r.externalId);
    return (
      s &&
      !(
        s.questionKey === axisKey(r.axis) &&
        s.imageId === r.imageId &&
        s.audience === r.audience &&
        s.prompt === r.prompt &&
        s.yesEffect === r.yesEffect &&
        s.noEffect === r.noEffect &&
        sameMeta(s.meta, r.meta)
      )
    );
  }).length;
}

/** Closes open questions the producer withdrew. Unanswered ones just close; answered ones drop their answers' gold like any no-outcome close. */
async function retireWithdrawn(
  db: Kysely<DB>,
  ids: string[],
  result: ImportResult,
  now: Date,
  batchSize: number
) {
  for (let at = 0; at < ids.length; at += batchSize) {
    const open = await db
      .selectFrom('KnightsQueueItem')
      .select('id')
      .where('status', '=', 'Open')
      .where('audience', 'is not', null)
      .where('externalId', 'in', ids.slice(at, at + batchSize))
      .execute();
    for (const { id } of open) {
      if (await closeOpenYesNoItem(db, id, 'retired', now)) result.retired++;
    }
  }
}
