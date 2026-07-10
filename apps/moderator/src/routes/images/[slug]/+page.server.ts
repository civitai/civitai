import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import { env } from '$env/dynamic/private';
import type { Actions, PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import {
  getImageReviewQueue,
  getReportedImageQueue,
  getAppealImageQueue,
  getModerationRuleDefinitions,
} from '$lib/server/image-review.service';
import {
  acceptImage,
  blockImage,
  resolveImageAppeal,
} from '$lib/server/image-moderation.service';
import { setReportStatus } from '$lib/server/reports.service';
import { ReportStatus } from '$lib/reports';
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
  const stripped = items.map(({ prompt, negativePrompt, ...item }) => item);
  const rules =
    view === 'modRule'
      ? await getModerationRuleDefinitions(
          stripped.map((i) => i.ruleId).filter((x): x is number => x != null)
        )
      : {};
  return {
    ...base,
    view,
    kind: 'review' as const,
    items: stripped.map((item) => ({
      ...item,
      ruleDefinition: item.ruleId != null ? (rules[item.ruleId] ?? null) : null,
    })),
    nextCursor,
  };
};

// Per-card verdicts. Access is enforced globally (hooks.server.ts) on the pathname, so a staff mod can't
// reach a senior view's action. `accept`/`block` also resolve the coupled report when a `reportId` is
// posted (the Reported queue): accept → Unactioned, block → Actioned, matching the legacy toolbar.
export const actions: Actions = {
  accept: async ({ request, locals }) => {
    const form = await request.formData();
    const imageId = Number(form.get('imageId'));
    if (!imageId) return fail(400, { error: 'Missing image id.' });
    const removeMinorFlag = form.get('removeMinorFlag') === 'true';
    const reportId = form.get('reportId') ? Number(form.get('reportId')) : undefined;

    await acceptImage({ imageId, removeMinorFlag, userId: locals.user.id });
    if (reportId)
      await setReportStatus({ id: reportId, status: ReportStatus.Unactioned, userId: locals.user.id });
    return { success: true, imageId };
  },

  block: async ({ request, locals }) => {
    const form = await request.formData();
    const imageId = Number(form.get('imageId'));
    if (!imageId) return fail(400, { error: 'Missing image id.' });
    const reportId = form.get('reportId') ? Number(form.get('reportId')) : undefined;

    await blockImage({ imageId, userId: locals.user.id });
    if (reportId)
      await setReportStatus({ id: reportId, status: ReportStatus.Actioned, userId: locals.user.id });
    return { success: true, imageId };
  },

  resolveAppeal: async ({ request, locals }) => {
    const form = await request.formData();
    const imageId = Number(form.get('imageId'));
    if (!imageId) return fail(400, { error: 'Missing image id.' });
    const status = form.get('status') === 'Approved' ? 'Approved' : 'Rejected';
    const resolvedMessage =
      String(form.get('resolvedMessage') ?? '')
        .trim()
        .slice(0, 1000) || undefined;

    await resolveImageAppeal({ imageId, status, resolvedMessage, userId: locals.user.id });
    return { success: true, imageId };
  },
};
