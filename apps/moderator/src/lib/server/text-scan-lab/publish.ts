import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { jsonField } from '$lib/server/query';
import {
  DraftConflictError,
  DraftError,
  getVisibleDraft,
  markPublished,
  validateDraftPrompts,
} from './drafts.service';
import { LabHarnessError, getPrompts, putPrompt, type LabPrompts } from './harness-client';
import { latestRunTotalsForSets, type LatestRun } from './runs.service';
import { listSets } from './test-sets.service';
import { blankPromptKeys, describeBlankPrompts, promptKeyName } from '$lib/text-scan-lab/labels';
import { PROMPT_KEYS, type PromptKey } from '$lib/text-scan-lab/types';

export const draftIdField = z.coerce.number().int().positive();
export const draftPromptsField = jsonField(
  z.record(z.string(), z.unknown(), { error: 'Malformed prompts.' }),
  'Malformed prompts.'
);
export const expectedUpdatedAtField = z.iso
  .datetime({ offset: true })
  .transform((v) => new Date(v));

export const publishSchema = z.object({
  draftId: draftIdField,
  note: z.string().trim().min(1, 'A publish note is required.').max(2000),
  expectedUpdatedAt: expectedUpdatedAtField,
});

/** What a published working copy is listed as: the publish note's first line. */
export function publishedName(note: string, at: Date): string {
  const line = note.trim().split('\n')[0].trim();
  if (!line) return `Published changes ${at.toISOString().slice(0, 10)}`;
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
}

/** Shown for a working copy saved again since the moderator loaded it. */
export const WORKING_CONFLICT = 'Your changes were changed in another tab — reload to see the latest.';

const names = (keys: readonly string[]) => keys.map((k) => promptKeyName(k as PromptKey)).join(', ');

const loadFailure = (e: unknown) =>
  `Could not load prompts: ${e instanceof LabHarnessError ? e.message : 'unexpected error'}`;

/**
 * Each key is its own prompt version, published one after another. Nothing rolls back: versions are
 * append-only, and putting the previous text back is the rollback. A refusal therefore names every
 * key that did go live.
 */
export async function publishDraft(input: z.infer<typeof publishSchema>, userId: number) {
  const draft = await getVisibleDraft(input.draftId, userId);
  if (!draft) return fail(404, { error: `Draft ${input.draftId} not found.` });
  const mine = draft.kind === 'working';
  const subject = mine ? 'Your changes' : 'The draft';
  if (draft.publishedAt) return fail(409, { error: 'This draft is already published.' });
  if (draft.updatedAt.getTime() !== input.expectedUpdatedAt.getTime())
    return fail(409, {
      error: mine ? WORKING_CONFLICT : new DraftConflictError().message,
    });
  const blank = blankPromptKeys(draft.prompts);
  if (blank.length) return fail(400, { error: describeBlankPrompts(blank) });
  try {
    validateDraftPrompts(draft.prompts);
  } catch (e) {
    if (e instanceof DraftError) return fail(e.status, { error: e.message });
    throw e;
  }
  const keys = PROMPT_KEYS.filter((k) => k in draft.prompts);
  if (!keys.length)
    return fail(400, {
      error: mine
        ? 'There are no changes to publish.'
        : 'This draft changes no prompt — nothing to publish.',
    });

  let active: LabPrompts['active'];
  try {
    active = (await getPrompts()).active;
  } catch (e) {
    return fail(502, { error: loadFailure(e) });
  }

  const promptIds: Record<string, number> = {};
  const published: string[] = [];
  const unchanged: string[] = [];
  for (const key of keys) {
    const content = draft.prompts[key]!;
    // Already live (a retry after a partial publish): record the live version, don't add a duplicate.
    if (active[key]?.content === content) {
      promptIds[key] = active[key].id;
      unchanged.push(key);
      continue;
    }
    try {
      promptIds[key] = (await putPrompt(key, content, input.note)).id;
      published.push(key);
    } catch (e) {
      const why = e instanceof LabHarnessError ? e.message : 'unexpected error';
      return fail(502, {
        error:
          `Publishing ${promptKeyName(key)} failed (${why}); it may or may not have gone live — check ` +
          'Versions. ' +
          (published.length
            ? `Already published: ${names(published)}.`
            : 'Nothing before it was published.') +
          ` ${mine ? 'Your changes stay' : 'The draft stays'} unpublished; publishing again skips what is already live.`,
        published,
      });
    }
  }

  try {
    await markPublished(draft.id, promptIds, input.expectedUpdatedAt, {
      userId,
      workingName: publishedName(input.note, new Date()),
    });
  } catch (e) {
    if (!(e instanceof DraftError)) throw e;
    return fail(e.status, {
      error: `Published ${names(published) || 'nothing new'}, but ${subject.toLowerCase()} could not be marked published: ${
        e instanceof DraftConflictError && mine ? WORKING_CONFLICT : e.message
      }`,
      published,
    });
  }
  return { success: true as const, published, unchanged };
}

export type SetRunTotals = {
  setId: number;
  setName: string;
  active: LatestRun | null;
  draft: LatestRun | null;
};

/** Each set's latest finished run on active and on the draft — shown at publish, never blocking it. */
export async function draftRunTotals(draftId: number): Promise<SetRunTotals[]> {
  const sets = await listSets();
  const latest = await latestRunTotalsForSets(sets.map((s) => s.id));
  const rows = sets.map((s) => ({
    setId: s.id,
    setName: s.name,
    active: latest.get(s.id)!.active,
    draft: latest.get(s.id)!.drafts[String(draftId)] ?? null,
  }));
  return rows.filter((r) => r.active || r.draft);
}
