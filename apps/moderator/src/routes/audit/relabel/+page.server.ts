import { error, fail } from '@sveltejs/kit';
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
  servableImageKeys,
} from '$lib/server/relabel.service';
import { parseAnswers, QUESTION_IDS } from '$lib/removal-label/questions';

// Blind relabel for the removal-label pilot. The labeler gets the image and nothing else: no image
// id (it opens Image Lookup, which shows the removal reason), no stratum, no prior label, no other
// labeler's answer.

const MAX_SKIPS = 100;

// Item ids reach a bigint column, and the URL is hand-editable: junk is dropped, not a 500.
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

export const load: PageServerLoad = async ({ locals, url }) => {
  requireAccess(locals.user, url.pathname);
  if (!locals.user) error(401, 'Not signed in');
  const labelerId = locals.user.id;
  const db = getModeratorDb();
  const pinnedId = asId(url.searchParams.get('item'));
  const skipped = parseSkips(url.searchParams.get('skip'));

  const [pinned, progress, lastItemId] = await Promise.all([
    pinnedId ? ownAnswer(db, labelerId, pinnedId) : Promise.resolve(null),
    labelerProgress(db, labelerId),
    lastAnsweredItemId(db, labelerId),
  ]);

  // A pinned image can be purged or CSAM-reported after it was answered; then the queue is shown
  // with a note rather than an empty page that claims nothing is left.
  const pinnedKeys = pinned ? await servableImageKeys(dbRead, [pinned.imageId]) : new Map();
  const showPinned = pinned && pinnedKeys.has(pinned.imageId) ? pinned : null;

  let item: { itemId: string; imageKey: string } | null = null;
  if (showPinned) {
    item = { itemId: showPinned.itemId, imageKey: pinnedKeys.get(showPinned.imageId) };
  } else {
    const candidates = await nextCandidates(db, labelerId, skipped);
    const keys = await servableImageKeys(
      dbRead,
      candidates.map((c) => c.imageId)
    );
    const next = candidates.find((c) => keys.has(c.imageId));
    if (next) item = { itemId: next.itemId, imageKey: keys.get(next.imageId) as string };
  }

  return {
    item,
    existing: showPinned?.answers ?? null,
    pinned: Boolean(showPinned),
    pinnedGone: Boolean(pinnedId && !showPinned),
    skipped,
    lastItemId,
    progress,
  };
};

export const actions: Actions = {
  answer: async ({ request, locals, url }) => {
    requireAccess(locals.user, url.pathname);
    const labelerId = locals.user?.id;
    if (!labelerId) return fail(401, { error: 'Not signed in', itemId: null });

    const form = await request.formData();
    const itemId = asId(String(form.get('itemId') ?? ''));
    if (!itemId) return fail(400, { error: 'Missing item', itemId: null });

    const answers = parseAnswers(Object.fromEntries(QUESTION_IDS.map((id) => [id, form.get(id)])));
    if (!answers) return fail(400, { error: 'Answer all four questions', itemId });

    const durationMs = Number(form.get('durationMs')) || null;
    const result = await saveAnswer(getModeratorDb(), { labelerId, itemId, answers, durationMs });
    if (!result.ok)
      return fail(result.reason === 'full' ? 409 : 404, {
        error:
          result.reason === 'full'
            ? 'Two other moderators already labelled that image, so your answer was not saved.'
            : 'That item no longer exists, so your answer was not saved.',
        itemId,
      });
    return { success: true };
  },
};
