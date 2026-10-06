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
import { PROMPT_KEYS } from '$lib/text-scan-lab/types';

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
  if (draft.publishedAt) return fail(409, { error: 'This draft is already published.' });
  if (draft.updatedAt.getTime() !== input.expectedUpdatedAt.getTime())
    return fail(409, { error: new DraftConflictError().message });
  try {
    validateDraftPrompts(draft.prompts);
  } catch (e) {
    if (e instanceof DraftError) return fail(e.status, { error: e.message });
    throw e;
  }
  const keys = PROMPT_KEYS.filter((k) => k in draft.prompts);
  if (!keys.length)
    return fail(400, { error: 'This draft overrides no prompt — add a key first.' });

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
          `Publishing ${key} failed (${why}); it may or may not have gone live — check its history. ` +
          (published.length
            ? `Already published: ${published.join(', ')}.`
            : 'No earlier key was published.') +
          ' The draft stays unpublished; publishing again skips keys already live.',
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
      error: `Published ${
        published.join(', ') || 'nothing new'
      }, but the draft could not be marked published: ${e.message}`,
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
