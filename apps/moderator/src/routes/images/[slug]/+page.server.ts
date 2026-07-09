import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { env } from '$env/dynamic/private';
import type { PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import { getImageReviewQueue } from '$lib/server/image-review.service';
import { IMAGE_REVIEW_SLUGS, type ImageReviewSlug } from '$lib/image-review';
import { allBrowsingLevelsFlag } from '@civitai/shared';
import { getPromptHighlightSegments } from '@civitai/mod-utils/prompt-audit';

const querySchema = z.object({
  cursor: z.coerce.number().int().positive().optional().catch(undefined),
  limit: z.coerce.number().int().min(10).max(200).catch(100),
  level: z.coerce.number().int().min(0).catch(allBrowsingLevelsFlag),
});

// One URL per review mode (/images/minor, /images/tag, …). The [slug] segment is the needsReview value;
// reject anything that isn't a known mode so this dynamic route can't shadow a real sibling (to-ingest,
// and later reported/appeals, are their own static routes and take precedence anyway). Access is gated
// globally in hooks.server.ts via the '/images' prefix.
export const load: PageServerLoad = async ({ params, url }) => {
  // Only the staff modes are valid [slug]s — csam has its own senior route, not this dynamic one.
  if (!(IMAGE_REVIEW_SLUGS as readonly string[]).includes(params.slug))
    error(404, 'Unknown review mode');
  const view = params.slug as ImageReviewSlug;

  const { cursor, limit, level } = parseQuery(url, querySchema);
  const data = await getImageReviewQueue({
    needsReview: view,
    browsingLevel: level,
    cursor,
    limit,
  });

  const base = {
    limit,
    level,
    nextCursor: data.nextCursor,
    civitaiUrl: env.CIVITAI_APP_URL ?? 'https://civitai.red',
    wide: true,
  };

  // Payload is discriminated by view. prompt/negativePrompt are query-internal and dropped from every
  // shape; only the two prompt-flagged views carry the highlight segments, computed server-side (the
  // audit word lists are ~50KB and never ship to the client).
  switch (view) {
    case 'minor':
    case 'remixSource':
      return {
        ...base,
        view,
        items: data.items.map(({ prompt, negativePrompt, ...item }) => ({
          ...item,
          promptHighlight: getPromptHighlightSegments(prompt, negativePrompt),
        })),
      };
    default:
      return {
        ...base,
        view,
        items: data.items.map(({ prompt, negativePrompt, ...item }) => item),
      };
  }
};

