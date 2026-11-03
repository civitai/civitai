import type { ExpressionBuilder } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { sql, utc } from '@civitai/db/kysely';
import { dbWrite } from '../db';
import { CORESET } from './coreset.config';
import { unservableReason, type Outcome } from './coreset.service';

export type YesNoQuestion = { key: string; prompt: string; active: boolean };

export type YesNoReferenceItem = {
  id: number;
  imageId: number;
  imageKey: string;
  imageName: string | null;
  questionKey: string;
  questionPrompt: string;
  answer: boolean;
  explanation: string | null;
  active: boolean;
  /** Acolyte answers that name this pair (see `hasNoAnswers`). While there are any, the pair can only be deactivated. */
  answers: number;
  createdAt: Date;
};

const GONE = 'This pair is no longer available. Reload the page.';

/** Yes/no questions a pair can be written for, inactive ones included so a pair can be prepared early. */
export async function getYesNoQuestions(): Promise<YesNoQuestion[]> {
  return dbWrite
    .selectFrom('KnightsQuestion')
    .select(['key', 'prompt', 'active'])
    .where('kind', '=', 'bool')
    .orderBy('key', 'asc')
    .execute();
}

/** Active pairs first, then newest. */
export async function getYesNoReferences(limit = CORESET.listLimit): Promise<YesNoReferenceItem[]> {
  return dbWrite
    .selectFrom('KnightsYesNoReference as r')
    .innerJoin('Image as i', 'i.id', 'r.imageId')
    .innerJoin('KnightsQuestion as q', 'q.key', 'r.questionKey')
    .select([
      'r.id',
      'r.imageId',
      'r.questionKey',
      'r.answer',
      'r.explanation',
      'r.active',
      'r.createdAt',
      sql<number>`(SELECT count(*)::int FROM "KnightsApprenticeAnswer" a WHERE a."yesNoReferenceId" = r."id")`.as(
        'answers'
      ),
      'i.url as imageKey',
      'i.name as imageName',
      'q.prompt as questionPrompt',
    ])
    .orderBy('r.active', 'desc')
    .orderBy('r.id', 'desc')
    .limit(limit)
    .execute();
}

export async function getYesNoReferenceCount(): Promise<number> {
  const row = await dbWrite
    .selectFrom('KnightsYesNoReference')
    .select(sql<string>`count(*)`.as('count'))
    .where('active', '=', true)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

export async function addYesNoReference(input: {
  imageId: number;
  questionKey: string;
  answer: boolean;
  explanation: string;
  createdBy: number;
}): Promise<Outcome> {
  const question = await dbWrite
    .selectFrom('KnightsQuestion')
    .select('kind')
    .where('key', '=', input.questionKey)
    .executeTakeFirst();
  if (!question) return { ok: false, error: `Question ${input.questionKey} was not found.` };
  if (question.kind !== 'bool') {
    return { ok: false, error: `${input.questionKey} is not a yes/no question.` };
  }

  const problem = await unservableReason(input.imageId);
  if (problem) return { ok: false, error: problem };

  const inserted = await dbWrite
    .insertInto('KnightsYesNoReference')
    .values({
      imageId: input.imageId,
      questionKey: input.questionKey,
      answer: input.answer,
      explanation: input.explanation.trim() || null,
      createdBy: input.createdBy,
      updatedAt: utc(new Date()),
    })
    .onConflict((oc) => oc.columns(['imageId', 'questionKey']).doNothing())
    .returning('id')
    .executeTakeFirst();
  return inserted
    ? { ok: true }
    : {
        ok: false,
        error: `Image ${input.imageId} already has a reference for this question. Change that one instead.`,
      };
}

export async function setYesNoReferenceActive(id: number, active: boolean): Promise<Outcome> {
  const updated = await dbWrite
    .updateTable('KnightsYesNoReference')
    .set({ active, updatedAt: utc(new Date()) })
    .where('id', '=', id)
    .executeTakeFirst();
  return Number(updated.numUpdatedRows) > 0 ? { ok: true } : { ok: false, error: GONE };
}

/**
 * Keys on `yesNoReferenceId` deliberately: "this pair has live answers". The Acolyte no-repeat rule keys on the
 * image + question snapshot instead, which outlives the pair.
 */
const hasNoAnswers = (eb: ExpressionBuilder<DB, 'KnightsYesNoReference'>) =>
  eb.not(
    eb.exists(
      eb
        .selectFrom('KnightsApprenticeAnswer')
        .select('id')
        .whereRef('yesNoReferenceId', '=', 'KnightsYesNoReference.id')
    )
  );

/** After a guarded write touched nothing: the pair is either gone or frozen by its answers. */
async function whyUntouched(id: number, verb: string): Promise<Outcome> {
  const remaining = await dbWrite
    .selectFrom('KnightsYesNoReference')
    .select('id')
    .where('id', '=', id)
    .executeTakeFirst();
  return remaining
    ? {
        ok: false,
        error: `Acolytes have answered this pair, so it cannot be ${verb}. Deactivate it instead.`,
      }
    : { ok: false, error: GONE };
}

/** Answered pairs are frozen: the recap shows the answer as given beside the explanation, so an edit would contradict it. */
export async function updateYesNoReference(
  id: number,
  input: { answer: boolean; explanation: string }
): Promise<Outcome> {
  const updated = await dbWrite
    .updateTable('KnightsYesNoReference')
    .set({
      answer: input.answer,
      explanation: input.explanation.trim() || null,
      updatedAt: utc(new Date()),
    })
    .where('id', '=', id)
    .where(hasNoAnswers)
    .executeTakeFirst();
  return Number(updated.numUpdatedRows) > 0 ? { ok: true } : whyUntouched(id, 'edited');
}

export async function deleteYesNoReference(id: number): Promise<Outcome> {
  const deleted = await dbWrite
    .deleteFrom('KnightsYesNoReference')
    .where('id', '=', id)
    .where(hasNoAnswers)
    .executeTakeFirst();
  return Number(deleted.numDeletedRows) > 0 ? { ok: true } : whyUntouched(id, 'deleted');
}
