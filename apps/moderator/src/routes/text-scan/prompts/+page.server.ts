import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { canAccess, requiresGrant } from '$lib/server/access';
import { parseForm, parseQuery } from '$lib/server/query';
import {
  DraftConflictError,
  DraftError,
  createDraft,
  getDraft,
  listDrafts,
  markPublished,
  updateDraft,
  validateDraftPrompts,
  type PromptDraft,
} from '$lib/server/text-scan-lab/drafts.service';
import {
  LabHarnessError,
  getPrompts,
  putPrompt,
  type LabPrompts,
} from '$lib/server/text-scan-lab/harness-client';
import { latestRunTotalsForSets, type LatestRun } from '$lib/server/text-scan-lab/runs.service';
import { listSets } from '$lib/server/text-scan-lab/test-sets.service';
import { PROMPT_KEYS } from '$lib/text-scan-lab/types';

const querySchema = z.object({
  key: z.enum(PROMPT_KEYS).catch('base'),
  draft: z.coerce.number().int().positive().optional().catch(undefined),
});

export type SetRunTotals = {
  setId: number;
  setName: string;
  active: LatestRun | null;
  draft: LatestRun | null;
};

/** Per open test set, the draft's and active's latest finished run — shown beside publish, never gating it. */
async function draftRunTotals(draftId: number): Promise<SetRunTotals[]> {
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

export const load: PageServerLoad = async ({ url, locals }) => {
  const q = parseQuery(url, querySchema);
  const [drafts, prompts] = await Promise.all([
    listDrafts(),
    getPrompts(q.key).then(
      (p): { ok: true; value: LabPrompts } => ({ ok: true, value: p }),
      (e: unknown) => ({
        ok: false as const,
        error: e instanceof LabHarnessError ? e.message : 'Could not load prompts.',
      })
    ),
  ]);
  const draft: PromptDraft | null = q.draft
    ? drafts.find((d) => d.id === q.draft) ?? (await getDraft(q.draft))
    : null;
  const runTotals =
    draft && canAccess(locals.user, '/text-scan/test-sets') ? await draftRunTotals(draft.id) : [];
  return { key: q.key, drafts, draft, prompts, runTotals, wide: true };
};

const fail400 = (error: string) => fail(400, { error });
/** A refusal the service explains goes back to the form; anything else is a real error. */
const refused = (e: unknown) => {
  if (e instanceof DraftError) return fail(e.status, { error: e.message });
  throw e;
};

const promptsField = z.string().transform((raw, ctx) => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // falls through to the issue below
  }
  ctx.addIssue({ code: 'custom', message: 'Malformed prompts.' });
  return z.NEVER;
});
const noteField = z
  .string()
  .trim()
  .max(2000, 'Note is at most 2000 characters.')
  .transform((v) => v || null);
const draftIdField = z.coerce.number().int().positive();
const expectedField = z.iso.datetime({ offset: true }).transform((v) => new Date(v));

export const actions: Actions = {
  createDraft: async ({ request, locals }) => {
    const input = parseForm(
      z.object({
        name: z
          .string()
          .trim()
          .min(1, 'Name the draft.')
          .max(100, 'Name is at most 100 characters.'),
        note: noteField.optional().default(null),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return fail400(input);
    try {
      const draft = await createDraft({ ...input, prompts: {} }, locals.user.id);
      return { success: true, draftId: draft.id };
    } catch (e) {
      return refused(e);
    }
  },

  saveDraft: async ({ request, locals }) => {
    const input = parseForm(
      z.object({
        draftId: draftIdField,
        prompts: promptsField,
        note: noteField.optional().default(null),
        expectedUpdatedAt: expectedField,
      }),
      await request.formData()
    );
    if (typeof input === 'string') return fail400(input);
    try {
      await updateDraft(input.draftId, input, locals.user.id);
      return { success: true };
    } catch (e) {
      return refused(e);
    }
  },

  // Each key is its own prompt version, published one after another. Nothing rolls back: versions are
  // append-only, and putting the previous text back is the rollback. A refusal therefore names every
  // key that did go live.
  publish: requiresGrant('textScan.prompt.publish', async ({ request }) => {
    const input = parseForm(
      z.object({
        draftId: draftIdField,
        note: z.string().trim().min(1, 'A publish note is required.').max(2000),
        expectedUpdatedAt: expectedField,
      }),
      await request.formData()
    );
    if (typeof input === 'string') return fail400(input);

    const draft = await getDraft(input.draftId);
    if (!draft) return fail(404, { error: `Draft ${input.draftId} not found.` });
    if (draft.publishedAt) return fail(409, { error: 'This draft is already published.' });
    if (draft.updatedAt.getTime() !== input.expectedUpdatedAt.getTime())
      return fail(409, { error: new DraftConflictError().message });
    try {
      validateDraftPrompts(draft.prompts);
    } catch (e) {
      return refused(e);
    }
    const keys = PROMPT_KEYS.filter((k) => k in draft.prompts);
    if (!keys.length) return fail400('This draft overrides no prompt — add a key first.');

    let active: LabPrompts['active'];
    try {
      active = (await getPrompts()).active;
    } catch (e) {
      return fail(502, {
        error: e instanceof LabHarnessError ? e.message : 'Could not load prompts.',
      });
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
      await markPublished(draft.id, promptIds, input.expectedUpdatedAt);
    } catch (e) {
      if (!(e instanceof DraftError)) throw e;
      return fail(e.status, {
        error: `Published ${
          published.join(', ') || 'nothing new'
        }, but the draft could not be marked published: ${e.message}`,
        published,
      });
    }
    return { success: true, published, unchanged };
  }),
};
