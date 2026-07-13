import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { env } from '$env/dynamic/private';
import type { Actions, PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import { getComicReviewQueue } from '$lib/server/comic-review.service';
import { acceptImage, blockImage } from '$lib/server/image-moderation.service';
import { syncSearchIndex } from '$lib/server/search-index';
import { getPromptHighlightSegments } from '@civitai/mod-utils/prompt-audit';

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
    // Highlight each panel's prompt server-side (word lists are server-only) so the card can render the
    // matched-term excerpt + "view full prompt" popover, same as the image review pages.
    items: items.map((panel) => ({
      ...panel,
      promptHighlight: panel.prompt ? getPromptHighlightSegments(panel.prompt) : null,
    })),
    nextCursor,
    limit,
    needsReview,
    reasons: REVIEW_REASONS,
    civitaiUrl: env.CIVITAI_APP_URL ?? 'https://civitai.com',
    wide: true,
  };
};

// Reuse the ported image moderation. Approving (acceptImage) clears the image's needsReview/ingestion so
// the comic flips back to visible; blocking (blockImage) soft-hides it. Either way, enqueue the parent
// comic project for a Meilisearch refresh (the one sanctioned main-app call) so the listing updates —
// mirrors the main app's re-queue on moderateImages.
async function moderatePanel(
  run: (args: { imageId: number; userId: number }) => Promise<void>,
  request: Request,
  userId: number
) {
  const form = await request.formData();
  const imageId = Number(form.get('imageId'));
  const projectId = Number(form.get('projectId'));
  if (!imageId) return fail(400, { error: 'Missing image id.' });

  await run({ imageId, userId });
  if (projectId) syncSearchIndex({ entityType: 'comic', entityId: projectId });
  return { success: true, imageId };
}

export const actions: Actions = {
  approve: ({ request, locals }) => moderatePanel(acceptImage, request, locals.user.id),
  block: ({ request, locals }) => moderatePanel(blockImage, request, locals.user.id),
};
