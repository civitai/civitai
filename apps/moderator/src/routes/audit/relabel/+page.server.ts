import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAccess } from '$lib/server/access';
import { dbRead } from '$lib/server/db';
import { getModeratorDb } from '$lib/server/moderator-db';
import {
  labelerProgress,
  lastAnsweredItemId,
  nextCandidates,
  ownAnswer,
  saveAnswer,
} from '$lib/server/relabel.service';
import { parseAnswers, type QuestionId } from '$lib/removal-label/questions';

// Blind relabel for the removal-label pilot. The labeler gets the image and nothing else: no image
// id (it opens Image Lookup, which shows the removal reason), no stratum, no prior label, no other
// labeler's answer.

const MAX_SKIPS = 100;

function asId(raw: string | null): string | null {
  return raw && /^\d+$/.test(raw) ? raw : null;
}

function parseSkips(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .filter((v) => /^\d+$/.test(v))
    .slice(-MAX_SKIPS);
}

async function imageKeys(imageIds: number[]): Promise<Map<number, string>> {
  if (!imageIds.length) return new Map();
  const rows = await dbRead
    .selectFrom('Image')
    .select(['id', 'url'])
    .where('id', 'in', imageIds)
    .where('type', '=', 'image')
    .execute();
  return new Map(rows.map((r) => [r.id, r.url]));
}

export const load: PageServerLoad = async ({ locals, url }) => {
  requireAccess(locals.user, url.pathname);
  const labelerId = locals.user?.id ?? 0;
  const db = getModeratorDb();
  const pinnedId = asId(url.searchParams.get('item'));
  const skipped = parseSkips(url.searchParams.get('skip'));

  const [pinned, progress, lastItemId] = await Promise.all([
    pinnedId ? ownAnswer(db, labelerId, pinnedId) : Promise.resolve(null),
    labelerProgress(db, labelerId),
    lastAnsweredItemId(db, labelerId),
  ]);

  // An image can be purged or deleted after it was sampled; such items are passed over rather
  // than shown as a broken image the labeler would have to guess at.
  const candidates = pinned ? [pinned] : await nextCandidates(db, labelerId, skipped);
  const keys = await imageKeys(candidates.map((c) => c.imageId));
  const next = candidates.find((c) => keys.has(c.imageId));

  return {
    item: next ? { itemId: next.itemId, imageKey: keys.get(next.imageId) as string } : null,
    existing: pinned?.answers ?? null,
    pinned: Boolean(pinned),
    skipped,
    lastItemId,
    progress,
  };
};

export const actions: Actions = {
  answer: async ({ request, locals, url }) => {
    requireAccess(locals.user, url.pathname);
    const labelerId = locals.user?.id;
    if (!labelerId) return fail(401, { error: 'Not signed in' });

    const form = await request.formData();
    const itemId = asId(String(form.get('itemId') ?? ''));
    if (!itemId) return fail(400, { error: 'Missing item' });

    const raw: Partial<Record<QuestionId, unknown>> = {
      minorPresent: form.get('minorPresent'),
      sexualLevel: form.get('sexualLevel'),
      violence: form.get('violence'),
      schoolSetting: form.get('schoolSetting'),
    };
    const answers = parseAnswers(raw);
    if (!answers) return fail(400, { error: 'Answer all four questions' });

    const durationMs = Number(form.get('durationMs')) || null;
    const result = await saveAnswer(getModeratorDb(), { labelerId, itemId, answers, durationMs });
    if (!result.ok)
      return fail(result.reason === 'full' ? 409 : 404, {
        error:
          result.reason === 'full'
            ? 'Two other moderators already labelled this image. Moving on.'
            : 'This item no longer exists.',
      });
    return { success: true };
  },
};
