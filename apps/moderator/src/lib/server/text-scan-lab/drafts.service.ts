import { sql, type Selectable } from 'kysely';
import { getModeratorDb } from '../moderator-db';
import type { text_scan_prompt_draft } from '../moderator-db/types';
import { LabError } from './errors';
import { blankPromptKeys, describeBlankPrompts } from '$lib/text-scan-lab/labels';
import { PROMPT_KEYS, type PromptKey } from '$lib/text-scan-lab/types';

export type DraftPrompts = Partial<Record<PromptKey, string>>;

export type DraftKind = 'working' | 'proposed';

export type PromptDraft = {
  id: number;
  kind: DraftKind;
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

/** A key in a draft is an override, so an empty one would publish an empty prompt: refused, never dropped.
 *  Unknown keys are refused first, so a blank one is never named as a prompt it is not. */
export function validateDraftPrompts(prompts: Record<string, unknown>): DraftPrompts {
  const unknownKeys = Object.keys(prompts).filter((k) => !isPromptKey(k));
  if (unknownKeys.length)
    throw new DraftValidationError(
      `Unknown prompt key ${unknownKeys.join(', ')} — allowed: ${PROMPT_KEYS.join(', ')}.`
    );
  const blank = blankPromptKeys(prompts);
  if (blank.length) throw new DraftValidationError(describeBlankPrompts(blank));
  return prompts as DraftPrompts;
}

function toDraft(r: Selectable<text_scan_prompt_draft>): PromptDraft {
  return {
    id: Number(r.id),
    kind: r.kind as DraftKind,
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

export async function listDrafts({ includeWorking = false } = {}): Promise<PromptDraft[]> {
  const rows = await getModeratorDb()
    .selectFrom('text_scan_prompt_draft')
    .selectAll()
    .$if(!includeWorking, (q) => q.where('kind', '=', 'proposed'))
    .orderBy(sql`published_at IS NOT NULL`)
    .orderBy('updated_at', 'desc')
    .limit(100)
    .execute();
  return rows.map(toDraft);
}

export async function getDraftsByIds(ids: number[]): Promise<PromptDraft[]> {
  if (!ids.length) return [];
  const rows = await getModeratorDb()
    .selectFrom('text_scan_prompt_draft')
    .selectAll()
    .where('id', 'in', ids.map(String))
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

const hiddenFrom = (draft: PromptDraft, userId: number) =>
  draft.kind === 'working' && draft.createdBy !== userId;

/** Another moderator's working copy is invisible: null, as if missing. */
export async function getVisibleDraft(id: number, userId: number): Promise<PromptDraft | null> {
  const draft = await getDraft(id);
  return draft && !hiddenFrom(draft, userId) ? draft : null;
}

async function refusal(
  id: number,
  missing: (draft: PromptDraft) => boolean = () => false
): Promise<DraftError> {
  const draft = await getDraft(id);
  if (!draft || missing(draft)) return new DraftNotFoundError(id);
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
    .where('kind', '=', 'proposed')
    .where('updated_at', '=', input.expectedUpdatedAt)
    .where('published_at', 'is', null)
    .returningAll()
    .executeTakeFirst();
  // A working copy changes only through its owner's saveWorkingCopy.
  if (!row) throw await refusal(id, (d) => d.kind === 'working');
  return toDraft(row);
}

// 'proposed' frees the one-per-moderator working-copy slot; the published copy stays listed under workingName.
export async function markPublished(
  id: number,
  promptIds: Record<string, number>,
  expectedUpdatedAt: Date,
  { userId, workingName }: { userId: number; workingName: string }
): Promise<PromptDraft> {
  const row = await getModeratorDb()
    .updateTable('text_scan_prompt_draft')
    .set({
      published_at: sql`now()`,
      published_prompt_ids: JSON.stringify(promptIds),
      name: sql`CASE WHEN kind = 'working' THEN ${workingName} ELSE name END`,
      kind: 'proposed',
    })
    .where('id', '=', String(id))
    .where((eb) => eb.or([eb('kind', '=', 'proposed'), eb('created_by', '=', userId)]))
    .where('updated_at', '=', expectedUpdatedAt)
    .where('published_at', 'is', null)
    .returningAll()
    .executeTakeFirst();
  if (!row) throw await refusal(id, (d) => hiddenFrom(d, userId));
  return toDraft(row);
}

const WORKING_COPY_NAME = 'My changes';

export async function getWorkingCopy(userId: number): Promise<PromptDraft | null> {
  const row = await getModeratorDb()
    .selectFrom('text_scan_prompt_draft')
    .selectAll()
    .where('created_by', '=', userId)
    .where('kind', '=', 'working')
    .executeTakeFirst();
  return row ? toDraft(row) : null;
}

/**
 * Saves the moderator's working copy. `expectedUpdatedAt` is the copy's token as loaded, or null when
 * none was: anything else on the row (another tab's save, create or discard) is a conflict. Saving no
 * override deletes the copy and returns null.
 */
export async function saveWorkingCopy(
  userId: number,
  prompts: Record<string, unknown>,
  expectedUpdatedAt: Date | null
): Promise<PromptDraft | null> {
  const valid = validateDraftPrompts(prompts);
  const db = getModeratorDb();

  if (!Object.keys(valid).length) {
    if (!expectedUpdatedAt) {
      if (await getWorkingCopy(userId)) throw new DraftConflictError();
      return null;
    }
    const deleted = await db
      .deleteFrom('text_scan_prompt_draft')
      .where('created_by', '=', userId)
      .where('kind', '=', 'working')
      .where('updated_at', '=', expectedUpdatedAt)
      .executeTakeFirst();
    if (!deleted.numDeletedRows) throw new DraftConflictError();
    return null;
  }

  const row = expectedUpdatedAt
    ? await db
        .updateTable('text_scan_prompt_draft')
        .set({ prompts: JSON.stringify(valid), updated_by: userId, updated_at: nextStamp })
        .where('created_by', '=', userId)
        .where('kind', '=', 'working')
        .where('updated_at', '=', expectedUpdatedAt)
        .returningAll()
        .executeTakeFirst()
    : await db
        .insertInto('text_scan_prompt_draft')
        .values({
          kind: 'working',
          name: WORKING_COPY_NAME,
          prompts: JSON.stringify(valid),
          created_by: userId,
          updated_by: userId,
          updated_at: firstStamp,
        })
        .onConflict((oc) => oc.column('created_by').where('kind', '=', 'working').doNothing())
        .returningAll()
        .executeTakeFirst();
  if (!row) throw new DraftConflictError();
  return toDraft(row);
}

export async function discardWorkingCopy(userId: number): Promise<void> {
  await getModeratorDb()
    .deleteFrom('text_scan_prompt_draft')
    .where('created_by', '=', userId)
    .where('kind', '=', 'working')
    .execute();
}

/**
 * Names the moderator's working copy and shares it as a proposed draft. `expectedUpdatedAt` is the copy
 * as the moderator last saw it, so what gets proposed is what they were looking at.
 */
export async function proposeWorkingCopy(
  userId: number,
  name: string,
  note: string | null,
  expectedUpdatedAt: Date
): Promise<PromptDraft> {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 100)
    throw new DraftValidationError('Name the draft in 1 to 100 characters.');
  const trimmedNote = note?.trim() || null;
  if (trimmedNote && trimmedNote.length > 2000)
    throw new DraftValidationError('Note is at most 2000 characters.');
  const row = await getModeratorDb()
    .updateTable('text_scan_prompt_draft')
    .set({
      kind: 'proposed',
      name: trimmed,
      note: trimmedNote,
      updated_by: userId,
      updated_at: nextStamp,
    })
    .where('created_by', '=', userId)
    .where('kind', '=', 'working')
    .where('updated_at', '=', expectedUpdatedAt)
    .returningAll()
    .executeTakeFirst();
  if (row) return toDraft(row);
  if (await getWorkingCopy(userId)) throw new DraftConflictError();
  throw new DraftError('You have no changes to propose.', 404);
}
