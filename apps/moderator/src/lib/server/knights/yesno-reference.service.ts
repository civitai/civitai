import type { ExpressionBuilder, Transaction } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { sql, utc } from '@civitai/db/kysely';
import { YESNO_PROMPT_MAX } from '../../knights/trials-limits';
import { dbWrite } from '../db';
import {
  CORESET,
  countRows,
  FIRST_PAGE,
  pageWindow,
  type ListPage,
  type ListQuery,
} from './coreset.config';
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
  /** The question Acolytes see for this pair. Null when it has none: they see the axis question's prompt. */
  prompt: string | null;
  active: boolean;
  /** Acolyte answers naming this pair. While any exist it can only be deactivated. */
  answers: number;
  createdAt: Date;
};

const GONE = 'This pair is no longer available. Reload the page.';
const NEEDS_PROMPT = 'Write the question Acolytes will be asked about this image.';
const PROMPT_TOO_LONG = `Keep the question to ${YESNO_PROMPT_MAX} characters or fewer.`;

function checkedPrompt(raw: string): { prompt: string } | { error: string } {
  const prompt = raw.trim();
  if (!prompt) return { error: NEEDS_PROMPT };
  return prompt.length > YESNO_PROMPT_MAX ? { error: PROMPT_TOO_LONG } : { prompt };
}

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
export async function getYesNoReferences(
  query: ListQuery = FIRST_PAGE,
  pageSize: number = CORESET.pageSize
): Promise<ListPage<YesNoReferenceItem>> {
  const filtered = () => {
    const base = dbWrite
      .selectFrom('KnightsYesNoReference as r')
      .innerJoin('Image as i', 'i.id', 'r.imageId')
      .innerJoin('KnightsQuestion as q', 'q.key', 'r.questionKey');
    return query.imageId === undefined ? base : base.where('r.imageId', '=', query.imageId);
  };
  const total = await countRows(filtered());
  const { page, offset, limit } = pageWindow(query.page, total, pageSize);
  const items = await filtered()
    .select([
      'r.id',
      'r.imageId',
      'r.questionKey',
      'r.answer',
      'r.explanation',
      'r.prompt',
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
    .offset(offset)
    .execute();
  return { items, total, page };
}

export async function getYesNoReferenceCount(): Promise<number> {
  const row = await dbWrite
    .selectFrom('KnightsYesNoReference')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('active', '=', true)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

export async function addYesNoReference(input: {
  imageId: number;
  questionKey: string;
  prompt: string;
  answer: boolean;
  explanation: string;
  createdBy: number;
}): Promise<Outcome> {
  const checked = checkedPrompt(input.prompt);
  if ('error' in checked) return { ok: false, error: checked.error };
  const { prompt } = checked;
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
      prompt,
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

// Lock first: a lone UPDATE or DELETE would test "no answers" against a snapshot taken before a concurrent answer
// committed. Statements after the lock see it.
async function lockPair(trx: Transaction<DB>, id: number): Promise<void> {
  await trx
    .selectFrom('KnightsYesNoReference')
    .select('id')
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
}

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

/** Answered pairs are frozen: history shows each answer against the answer, explanation and question text it was given to. */
export async function updateYesNoReference(
  id: number,
  input: { answer: boolean; explanation: string; prompt: string }
): Promise<Outcome> {
  const checked = checkedPrompt(input.prompt);
  if ('error' in checked) return { ok: false, error: checked.error };
  const { prompt } = checked;
  const updated = await dbWrite.transaction().execute(async (trx) => {
    await lockPair(trx, id);
    return trx
      .updateTable('KnightsYesNoReference')
      .set({
        answer: input.answer,
        explanation: input.explanation.trim() || null,
        prompt,
        updatedAt: utc(new Date()),
      })
      .where('id', '=', id)
      .where(hasNoAnswers)
      .executeTakeFirst();
  });
  return Number(updated.numUpdatedRows) > 0 ? { ok: true } : whyUntouched(id, 'edited');
}

export async function deleteYesNoReference(id: number): Promise<Outcome> {
  const deleted = await dbWrite.transaction().execute(async (trx) => {
    await lockPair(trx, id);
    return trx
      .deleteFrom('KnightsYesNoReference')
      .where('id', '=', id)
      .where(hasNoAnswers)
      .executeTakeFirst();
  });
  return Number(deleted.numDeletedRows) > 0 ? { ok: true } : whyUntouched(id, 'deleted');
}
