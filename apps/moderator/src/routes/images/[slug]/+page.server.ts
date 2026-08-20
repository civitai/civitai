import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { parseForm, parseIdList, parseQuery } from '$lib/server/query';
import {
  getImageReviewQueue,
  getReportedImageQueue,
  getAppealImageQueue,
  getModerationRuleDefinitions,
  getReviewQueueTags,
} from '$lib/server/image-review.service';
import {
  acceptImage,
  blockImage,
  resolveImageAppeal,
  getPendingImageAppealAppellants,
  sendBulkAppealEmails,
} from '$lib/server/image-moderation.service';
import { setReportStatus } from '$lib/server/reports.service';
import { getActorMeta } from '$lib/server/request-meta';
import { getModel3DsByThumbnailImageIds, unpublishModel3d } from '$lib/server/model3d.service';
import { ReportStatus } from '$lib/reports';
import { IMAGE_VIEW_SLUGS, type ImageViewSlug } from '$lib/image-review';
import { violationInputSchema } from '$lib/violations';
import { parseImageFlagValue } from '$lib/image-flags';
import { isRatingLevel } from '$lib/nsfw-levels';
import { updateImageNsfwLevel } from '$lib/server/image-nsfw-level';
import { setImageFlag } from '$lib/server/user-actions.service';
import { allBrowsingLevelsWithBlockedFlag } from '@civitai/shared';
import { getPromptHighlightSegments } from '@civitai/mod-utils/prompt-audit';

const querySchema = z.object({
  cursor: z.coerce.number().int().positive().optional().catch(undefined),
  limit: z.coerce.number().int().min(10).max(200).catch(100),
  level: z.coerce.number().int().min(0).catch(allBrowsingLevelsWithBlockedFlag),
});

const parseIds = (v: unknown): number[] => parseIdList(String(v ?? ''));

/** `string`, not the union: `blockImage` takes the ClickHouse column's type, and the schema is what
 *  guarantees the value is one of the enum's. Returns the refusal message on a bad value, like the
 *  three sibling removal actions — a dropped reason files the removal under nothing at all. */
function parseViolation(
  form: FormData
): { violationType?: string; violationDetails?: string } | string {
  return parseForm(violationInputSchema, form);
}

async function withModel3d<T extends { id: number }>(items: T[]) {
  const model3ds = await getModel3DsByThumbnailImageIds(items.map((i) => i.id));
  return items.map((i) => ({ ...i, model3d: model3ds[i.id] ?? null }));
}

export const load: PageServerLoad = async ({ params, url }) => {
  if (!(IMAGE_VIEW_SLUGS as readonly string[]).includes(params.slug))
    error(404, 'Unknown image view');
  const view = params.slug as ImageViewSlug;

  const { cursor, limit, level } = parseQuery(url, querySchema);
  const tagIds = parseIds(url.searchParams.get('tags'));
  const excludedTagIds = parseIds(url.searchParams.get('notags'));

  const base = {
    limit,
    level,
    wide: true,
    tagIds,
    excludedTagIds,
    tagOptions: [] as { id: number; name: string }[],
  };

  if (view === 'reported') {
    const { items, nextCursor } = await getReportedImageQueue({
      browsingLevel: level,
      cursor,
      limit,
    });
    return {
      ...base,
      view,
      kind: 'reported' as const,
      items: await withModel3d(items),
      nextCursor,
    };
  }

  if (view === 'appeals') {
    const { items, nextCursor } = await getAppealImageQueue({
      browsingLevel: level,
      cursor,
      limit,
    });
    return { ...base, view, kind: 'appeal' as const, items: await withModel3d(items), nextCursor };
  }

  if (view === 'minor' || view === 'remixSource') {
    const { items, nextCursor } = await getImageReviewQueue({
      needsReview: view,
      browsingLevel: level,
      tagIds,
      excludedTagIds,
      cursor,
      limit,
    });
    // The minor queue highlights only minor-relevant categories; other queues highlight the whole prompt.
    const categories = view === 'minor' ? (['minor', 'young', 'age'] as const) : undefined;
    return {
      ...base,
      view,
      kind: 'review-highlight' as const,
      tagOptions: await getReviewQueueTags(view),
      items: await withModel3d(
        items.map(({ prompt, negativePrompt, ...item }) => ({
          ...item,
          promptHighlight: getPromptHighlightSegments(prompt, negativePrompt, {
            categories: categories ? [...categories] : undefined,
          }),
        }))
      ),
      nextCursor,
    };
  }

  const { items, nextCursor } = await getImageReviewQueue({
    needsReview: view,
    browsingLevel: level,
    tagIds,
    excludedTagIds,
    cursor,
    limit,
  });
  const tagOptions = await getReviewQueueTags(view);
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
    tagOptions,
    items: await withModel3d(
      stripped.map((item) => ({
        ...item,
        ruleDefinition: item.ruleId != null ? rules[item.ruleId] ?? null : null,
      }))
    ),
    nextCursor,
  };
};

// accept/block also resolve a coupled report when a `reportId` is posted: accept → Unactioned, block → Actioned.
export const actions: Actions = {
  accept: async ({ request, locals }) => {
    const form = await request.formData();
    const imageId = Number(form.get('imageId'));
    if (!imageId) return fail(400, { error: 'Missing image id.' });
    const removeMinorFlag = form.get('removeMinorFlag') === 'true';
    const reportId = form.get('reportId') ? Number(form.get('reportId')) : undefined;

    await acceptImage({ imageId, removeMinorFlag, userId: locals.user.id });
    if (reportId)
      await setReportStatus({
        id: reportId,
        status: ReportStatus.Unactioned,
        userId: locals.user.id,
      });
    return { success: true, imageId };
  },

  block: async (event) => {
    const { request, locals } = event;
    const form = await request.formData();
    const imageId = Number(form.get('imageId'));
    if (!imageId) return fail(400, { error: 'Missing image id.' });
    const reportId = form.get('reportId') ? Number(form.get('reportId')) : undefined;

    const violation = parseViolation(form);
    if (typeof violation === 'string') return fail(400, { error: violation });

    await blockImage({
      imageId,
      userId: locals.user.id,
      ...violation,
      ...getActorMeta(event),
    });
    if (reportId)
      await setReportStatus({
        id: reportId,
        status: ReportStatus.Actioned,
        userId: locals.user.id,
      });
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

  // Rating and flag are corrections, not verdicts: neither clears `needsReview`, so the image stays in
  // the queue and still has to be accepted or removed.
  setRating: async ({ request, locals }) => {
    const form = await request.formData();
    const imageIds = parseIds(form.get('imageIds'));
    const nsfwLevel = Number(form.get('nsfwLevel'));
    if (!imageIds.length) return fail(400, { error: 'Missing image id.' });
    if (!isRatingLevel(nsfwLevel)) return fail(400, { error: 'Invalid rating level.' });

    // `updateImageNsfwLevel` throws bare Errors (missing image, Redis down). Uncaught, a form action
    // error replaces the queue with an error page, taking the record of what was already actioned
    // with it — and sometimes AFTER the rating committed. Same guard as Front Page Audit's.
    //
    // Sequential, and the failures are named: a partial batch the moderator cannot see is worse than
    // a refusal, because the images it did rate are indistinguishable from the ones it did not.
    const failed: number[] = [];
    for (const id of imageIds) {
      try {
        await updateImageNsfwLevel({
          id,
          nsfwLevel,
          reason: 'Moderator queue rating',
          userId: locals.user.id,
        });
      } catch (e) {
        console.error('[images] setRating failed', { id, error: e });
        failed.push(id);
      }
    }
    if (failed.length)
      return fail(400, {
        error:
          failed.length === imageIds.length
            ? 'Could not set that rating — reload the queue.'
            : `Rated ${imageIds.length - failed.length} of ${
                imageIds.length
              }. Failed: ${failed.join(', ')}.`,
      });
    return { success: true, nsfwLevel };
  },

  setFlag: async ({ request, locals }) => {
    const form = await request.formData();
    const imageIds = parseIds(form.get('imageIds'));
    const flagValue = parseImageFlagValue(String(form.get('flagValue') ?? ''));
    if (!imageIds.length) return fail(400, { error: 'Missing image id.' });
    if (!flagValue) return fail(400, { error: 'Unknown flag.' });

    const result = await setImageFlag({ ...flagValue, imageIds, moderatorId: locals.user.id });
    if (!result.ok) return fail(400, { error: result.error });
    return { success: true };
  },

  unpublishModel3d: async ({ request, locals }) => {
    const form = await request.formData();
    const model3dId = Number(form.get('model3dId'));
    if (!model3dId) return fail(400, { error: 'Missing model id.' });
    await unpublishModel3d({ id: model3dId, userId: locals.user.id });
    return { success: true, model3dId };
  },

  // reportIds couples the report status (accept → Unactioned, block → Actioned).
  bulkAccept: async ({ request, locals }) => {
    const form = await request.formData();
    const imageIds = parseIds(form.get('imageIds'));
    const reportIds = parseIds(form.get('reportIds'));
    const removeMinorFlag = form.get('removeMinorFlag') === 'true';
    // Snapshot any appeal appellants before resolving, then email each once (deduped) instead of per-image.
    const appellants = await getPendingImageAppealAppellants(imageIds);
    await Promise.all(
      imageIds.map((imageId) =>
        acceptImage({ imageId, removeMinorFlag, userId: locals.user.id, deferAppealEmail: true })
      )
    );
    await sendBulkAppealEmails(appellants, true);
    await Promise.all(
      reportIds.map((id) =>
        setReportStatus({ id, status: ReportStatus.Unactioned, userId: locals.user.id })
      )
    );
    return { success: true };
  },

  bulkBlock: async (event) => {
    const { request, locals } = event;
    const form = await request.formData();
    const imageIds = parseIds(form.get('imageIds'));
    const reportIds = parseIds(form.get('reportIds'));
    const violation = parseViolation(form);
    if (typeof violation === 'string') return fail(400, { error: violation });
    const actor = { ...violation, ...getActorMeta(event) };
    await Promise.all(
      imageIds.map((imageId) => blockImage({ imageId, userId: locals.user.id, ...actor }))
    );
    await Promise.all(
      reportIds.map((id) =>
        setReportStatus({ id, status: ReportStatus.Actioned, userId: locals.user.id })
      )
    );
    return { success: true };
  },

  bulkResolveAppeal: async ({ request, locals }) => {
    const form = await request.formData();
    const imageIds = parseIds(form.get('imageIds'));
    const status = form.get('status') === 'Approved' ? 'Approved' : 'Rejected';
    const appellants = await getPendingImageAppealAppellants(imageIds);
    await Promise.all(
      imageIds.map((imageId) =>
        resolveImageAppeal({ imageId, status, userId: locals.user.id, deferAppealEmail: true })
      )
    );
    await sendBulkAppealEmails(appellants, status === 'Approved');
    return { success: true };
  },
};
