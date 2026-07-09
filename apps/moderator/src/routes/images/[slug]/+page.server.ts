import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { env } from '$env/dynamic/private';
import type { PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import {
  getImageReviewQueue,
  getReportedImageQueue,
  getAppealImageQueue,
} from '$lib/server/image-review.service';
import { IMAGE_VIEW_SLUGS, type ImageViewSlug } from '$lib/image-review';
import { allBrowsingLevelsFlag } from '@civitai/shared';
import { getPromptHighlightSegments } from '@civitai/mod-utils/prompt-audit';

const querySchema = z.object({
  cursor: z.coerce.number().int().positive().optional().catch(undefined),
  limit: z.coerce.number().int().min(10).max(200).catch(100),
  level: z.coerce.number().int().min(0).catch(allBrowsingLevelsFlag),
});

// Every image queue is one URL: /images/<view>. Validate against the full view set, then dispatch to
// the right service and return a `kind`-discriminated payload (review-highlight / review / reported /
// appeal). Access — staff for the review modes + reported, senior for csam + appeals — is enforced
// upstream in hooks.server.ts, keyed on the concrete pathname via the NAVIGATION roles. The explicit
// guards below let `view` narrow per branch so each payload's `view` is exactly its own modes.
export const load: PageServerLoad = async ({ params, url }) => {
  if (!(IMAGE_VIEW_SLUGS as readonly string[]).includes(params.slug))
    error(404, 'Unknown image view');
  const view = params.slug as ImageViewSlug;

  const { cursor, limit, level } = parseQuery(url, querySchema);
  const base = {
    limit,
    level,
    civitaiUrl: env.CIVITAI_APP_URL ?? 'https://civitai.red',
    wide: true,
  };

  if (view === 'reported') {
    const { items, nextCursor } = await getReportedImageQueue({ browsingLevel: level, cursor, limit });
    return { ...base, view, kind: 'reported' as const, items, nextCursor };
  }

  if (view === 'appeals') {
    const { items, nextCursor } = await getAppealImageQueue({ browsingLevel: level, cursor, limit });
    return { ...base, view, kind: 'appeal' as const, items, nextCursor };
  }

  if (view === 'minor' || view === 'remixSource') {
    const { items, nextCursor } = await getImageReviewQueue({
      needsReview: view,
      browsingLevel: level,
      cursor,
      limit,
    });
    return {
      ...base,
      view,
      kind: 'review-highlight' as const,
      items: items.map(({ prompt, negativePrompt, ...item }) => ({
        ...item,
        promptHighlight: getPromptHighlightSegments(prompt, negativePrompt),
      })),
      nextCursor,
    };
  }

  // view: 'poi' | 'tag' | 'newUser' | 'modRule' | 'csam'
  const { items, nextCursor } = await getImageReviewQueue({
    needsReview: view,
    browsingLevel: level,
    cursor,
    limit,
  });
  return {
    ...base,
    view,
    kind: 'review' as const,
    items: items.map(({ prompt, negativePrompt, ...item }) => item),
    nextCursor,
  };
};
