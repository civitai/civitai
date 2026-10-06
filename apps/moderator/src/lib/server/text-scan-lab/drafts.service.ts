import { sql, type Selectable } from 'kysely';
import { getModeratorDb } from '../moderator-db';
import type { text_scan_prompt_draft } from '../moderator-db/types';
import { LabError } from './errors';
import { PROMPT_KEYS, type PromptKey } from '$lib/text-scan-lab/types';

export type DraftPrompts = Partial<Record<PromptKey, string>>;

export type PromptDraft = {
  id: number;
  name: string;
  prompts: DraftPrompts;
  note: string | null;
  createdBy: number;
  createdAt: Date;
  updatedBy: number;
  updatedAt: Date;
  publishedAt: Date | null;
  publishedPromptIds: Record<string, number> | null;
};

export class DraftError extends LabError {}
export class DraftValidationError extends DraftError {
  constructor(message: string) {
    super(message, 400);
  }
}
export class DraftNotFoundError extends DraftError {
  constructor(id: number) {
    super(`Draft ${id} not found.`, 404);
  }
}
export class DraftConflictError extends DraftError {
  constructor() {
    super('This draft was changed since you loaded it — reload to see the latest version.', 409);
  }
}
export class DraftPublishedError extends DraftError {
  constructor() {
    super('This draft is already published and can no longer change.', 409);
  }
}

const isPromptKey = (key: string): key is PromptKey =>
  (PROMPT_KEYS as readonly string[]).includes(key);

/** A key in a draft is an override, so an empty one would publish an empty prompt: refused, never dropped. */
export function validateDraftPrompts(prompts: Record<string, unknown>): DraftPrompts {
  const unknownKeys = Object.keys(prompts).filter((k) => !isPromptKey(k));
  if (unknownKeys.length)
    throw new DraftValidationError(
      `Unknown prompt key ${unknownKeys.join(', ')} — allowed: ${PROMPT_KEYS.join(', ')}.`
    );
  const blank = Object.entries(prompts)
    .filter(([, v]) => typeof v !== 'string' || !v.trim())
    .map(([k]) => k);
  if (blank.length)
    throw new DraftValidationError(
      `${blank.join(', ')} ${
        blank.length === 1 ? 'is' : 'are'
      } empty — write the prompt or remove the key from the draft.`
    );
  return prompts as DraftPrompts;
}

function toDraft(r: Selectable<text_scan_prompt_draft>): PromptDraft {
  return {
    id: Number(r.id),
    name: r.name,
    prompts: r.prompts as DraftPrompts,
    note: r.note,
    createdBy: r.created_by,
    createdAt: new Date(r.created_at),
    updatedBy: r.updated_by,
    updatedAt: new Date(r.updated_at),
    publishedAt: r.published_at ? new Date(r.published_at) : null,
    publishedPromptIds: (r.published_prompt_ids as Record<string, number> | null) ?? null,
  };
}

// `updated_at` is the conflict token and round-trips through a JS Date, which holds milliseconds:
// stored at microsecond precision it would never compare equal again. Strictly increasing, so two saves
// in one millisecond still move it.
const firstStamp = sql<Date>`date_trunc('milliseconds', now())`;
const nextStamp = sql<Date>`greatest(date_trunc('milliseconds', now()), updated_at + interval '1 millisecond')`;

export async function listDrafts(): Promise<PromptDraft[]> {
  const rows = await getModeratorDb()
    .selectFrom('text_scan_prompt_draft')
    .selectAll()
    .orderBy(sql`published_at IS NOT NULL`)
    .orderBy('updated_at', 'desc')
    .limit(100)
    .execute();
  return rows.map(toDraft);
}

export async function getDraft(id: number): Promise<PromptDraft | null> {
  const row = await getModeratorDb()
    .selectFrom('text_scan_prompt_draft')
    .selectAll()
    .where('id', '=', String(id))
    .executeTakeFirst();
  return row ? toDraft(row) : null;
}

export async function createDraft(
  input: { name: string; prompts: Record<string, unknown>; note: string | null },
  userId: number
): Promise<PromptDraft> {
  const prompts = validateDraftPrompts(input.prompts);
  const row = await getModeratorDb()
    .insertInto('text_scan_prompt_draft')
    .values({
      name: input.name,
      prompts: JSON.stringify(prompts),
      note: input.note,
      created_by: userId,
      updated_by: userId,
      updated_at: firstStamp,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toDraft(row);
}

/** Why a guarded write matched no row. */
async function refusal(id: number): Promise<DraftError> {
  const draft = await getDraft(id);
  if (!draft) return new DraftNotFoundError(id);
  if (draft.publishedAt) return new DraftPublishedError();
  return new DraftConflictError();
}

export async function updateDraft(
  id: number,
  input: { prompts: Record<string, unknown>; note: string | null; expectedUpdatedAt: Date },
  userId: number
): Promise<PromptDraft> {
  const prompts = validateDraftPrompts(input.prompts);
  const row = await getModeratorDb()
    .updateTable('text_scan_prompt_draft')
    .set({
      prompts: JSON.stringify(prompts),
      note: input.note,
      updated_by: userId,
      updated_at: nextStamp,
    })
    .where('id', '=', String(id))
    .where('updated_at', '=', input.expectedUpdatedAt)
    .where('published_at', 'is', null)
    .returningAll()
    .executeTakeFirst();
  if (!row) throw await refusal(id);
  return toDraft(row);
}

export async function markPublished(
  id: number,
  promptIds: Record<string, number>,
  expectedUpdatedAt: Date
): Promise<PromptDraft> {
  const row = await getModeratorDb()
    .updateTable('text_scan_prompt_draft')
    .set({ published_at: sql`now()`, published_prompt_ids: JSON.stringify(promptIds) })
    .where('id', '=', String(id))
    .where('updated_at', '=', expectedUpdatedAt)
    .where('published_at', 'is', null)
    .returningAll()
    .executeTakeFirst();
  if (!row) throw await refusal(id);
  return toDraft(row);
}
