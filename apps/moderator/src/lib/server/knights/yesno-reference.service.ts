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
        error: `Image ${input.imageId} already has a reference for this question. Delete or edit that one instead.`,
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

export async function deleteYesNoReference(id: number): Promise<Outcome> {
  const deleted = await dbWrite
    .deleteFrom('KnightsYesNoReference')
    .where('id', '=', id)
    .executeTakeFirst();
  return Number(deleted.numDeletedRows) > 0 ? { ok: true } : { ok: false, error: GONE };
}
