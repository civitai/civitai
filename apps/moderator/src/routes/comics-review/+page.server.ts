import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import { getComicReviewQueue } from '$lib/server/comic-review.service';
import { acceptImage, blockImage } from '$lib/server/image-moderation.service';
import { getActorMeta } from '$lib/server/request-meta';
import { getPromptHighlightSegments } from '@civitai/mod-utils/prompt-audit';
import type { RequestEvent } from './$types';

const REVIEW_REASONS = [
  { value: 'all', label: 'Any reason' },
  { value: 'minor', label: 'Minor flag' },
  { value: 'poi', label: 'POI flag' },
  { value: 'newUser', label: 'New user' },
  { value: 'bestiality', label: 'Bestiality' },
  { value: 'appeal', label: 'Appeal pending' },
  { value: 'csam', label: 'CSAM (manual)' },
] as const;

const querySchema = z.object({
  cursor: z.coerce.number().int().positive().optional().catch(undefined),
  limit: z.coerce.number().int().min(10).max(50).catch(25),
  needsReview: z.enum(REVIEW_REASONS.map((r) => r.value) as [string, ...string[]]).catch('all'),
});

export const load: PageServerLoad = async ({ url }) => {
  const { cursor, limit, needsReview } = parseQuery(url, querySchema);
  const { items, nextCursor } = await getComicReviewQueue({
    limit,
    cursor,
    needsReview: needsReview === 'all' ? undefined : needsReview,
  });
  return {
    // Highlight the prompt server-side — the word lists are server-only.
    items: items.map((panel) => ({
      ...panel,
      promptHighlight: panel.prompt ? getPromptHighlightSegments(panel.prompt) : null,
    })),
    nextCursor,
    limit,
    needsReview,
    reasons: REVIEW_REASONS,
    wide: true,
  };
};

// acceptImage/blockImage already re-queue every parent comic (queueComicsForImages), so nothing
// comic-specific is needed here.
async function moderatePanel(
  run: (args: {
    imageId: number;
    userId: number;
    ip?: string;
    userAgent?: string;
  }) => Promise<void>,
  event: RequestEvent
) {
  const form = await event.request.formData();
  const imageId = Number(form.get('imageId'));
  if (!imageId) return fail(400, { error: 'Missing image id.' });

  // acceptImage ignores ip/userAgent; blockImage uses them for the DeleteTOS analytics row.
  // Refused rather than thrown: an uncaught throw here renders a 500 page, which tells the moderator
  // nothing about whether the panel was actioned and unmounts the queue they were working.
  try {
    await run({ imageId, userId: event.locals.user.id, ...getActorMeta(event) });
  } catch (e) {
    return fail(400, {
      error:
        e instanceof Error ? e.message : 'The action failed — re-check the panel before retrying.',
      imageId,
    });
  }
  return { success: true, imageId };
}

export const actions: Actions = {
  approve: (event) => moderatePanel(acceptImage, event),
  block: (event) => moderatePanel(blockImage, event),
};
