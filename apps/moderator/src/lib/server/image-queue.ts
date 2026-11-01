import { fail, type Actions } from '@sveltejs/kit';
import { z } from 'zod';
import { int4Id, parseForm, parseIdList, parseQuery } from '$lib/server/query';
import {
  getCsamQueueByUser,
  getImageReviewQueue,
  getReportedImageQueue,
  getAppealImageQueue,
  getModerationRuleDefinitions,
  getReviewQueueTags,
} from '$lib/server/image-review.service';
import {
  acceptImage,
  blockImage,
  closedAppellants,
  dismissFromCsamQueue,
  dismissUserFromCsamQueue,
  FlagOnlyRemovedError,
  resolveImageAppeal,
  sendBulkAppealEmails,
} from '$lib/server/image-moderation.service';
import { setReportStatus } from '$lib/server/reports.service';
import { getActorMeta } from '$lib/server/request-meta';
import { dbRead } from '$lib/server/db';
import { approvedAppealOf } from '$lib/server/removal-hold';
import { getLatestApprovedImageAppeals } from '@civitai/db-queries/image-removal-confirmation';
import { heldRemovalMessage, type HeldRemoval } from '$lib/server/removal-hold';
import { getModel3DsByThumbnailImageIds, unpublishModel3d } from '$lib/server/model3d.service';
import { ReportStatus } from '$lib/reports';
import { FLAG_KEPT_THROUGH_BLOCK, type ImageViewSlug } from '$lib/image-review';
import { violationInputSchema } from '$lib/violations';
import { parseImageFlagValue } from '$lib/image-flags';
import { isRatingLevel } from '$lib/nsfw-levels';
import { updateImageNsfwLevel } from '$lib/server/image-nsfw-level';
import { setImageFlag } from '$lib/server/user-actions.service';
import { checkedResolutionReason, resolutionReasonFields } from '$lib/server/resolution-reason';
import type { ResolutionVerdict } from '@civitai/shared/resolution-reasons';
import { allBrowsingLevelsWithBlockedFlag } from '@civitai/shared';
import { getPromptHighlightSegments } from '@civitai/mod-utils/prompt-audit';

const querySchema = z.object({
  cursor: z.coerce.number().int().positive().optional().catch(undefined),
  limit: z.coerce.number().int().min(10).max(200).catch(100),
  level: z.coerce.number().int().min(0).catch(allBrowsingLevelsWithBlockedFlag),
  userId: int4Id.optional().catch(undefined),
});

const parseIds = (v: unknown): number[] => parseIdList(String(v ?? ''));

const FLAG_ONLY_REASON = 'removed with only the review flag left';
const FLAG_ONLY_REMEDY = 'Dismiss the flag from its review queue, or restore the image. Reload.';

/** `string`, not the union: `blockImage` takes the ClickHouse column's type, and the schema is what
 *  guarantees the value is one of the enum's. Returns the refusal message on a bad value, like the
 *  three sibling removal actions — a dropped reason files the removal under nothing at all. */
function parseViolation(
  form: FormData
): { violationType?: string; violationDetails?: string } | string {
  return parseForm(violationInputSchema, form);
}

/** Each card's Model3D parent, and the image's latest approved appeal, so a moderator sees it before
 *  removing the image again. */
async function withModel3d<T extends { id: number }>(items: T[]) {
  const ids = items.map((i) => i.id);
  const [model3ds, appeals] = await Promise.all([
    getModel3DsByThumbnailImageIds(ids),
    getLatestApprovedImageAppeals(dbRead, ids),
  ]);
  return items.map((i) => ({
    ...i,
    model3d: model3ds[i.id] ?? null,
    approvedAppeal: approvedAppealOf(appeals.get(i.id)),
  }));
}

/**
 * One image queue's cards, for `view`. Shared by `/images/[slug]` (the review queues) and
 * `/reports/image` (the reported-image queue, which moved there from `/images/reported`).
 */
export async function loadImageQueue(view: ImageViewSlug, url: URL) {
  const { cursor, limit, level, userId } = parseQuery(url, querySchema);
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
    // `?report=<id>`: the one report a link names (`reportActionPath`), at any status.
    const reportParam = Number(url.searchParams.get('report'));
    const reportId = Number.isInteger(reportParam) && reportParam > 0 ? reportParam : undefined;
    const { items, nextCursor } = await getReportedImageQueue({
      browsingLevel: level,
      cursor: reportId ? undefined : cursor,
      limit,
      reportId,
    });
    return {
      ...base,
      view,
      kind: 'reported' as const,
      items: await withModel3d(items),
      nextCursor: reportId ? undefined : nextCursor,
      singleReport: reportId ?? null,
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

  const csamUserId = view === FLAG_KEPT_THROUGH_BLOCK ? userId : undefined;
  const { items, nextCursor } = await getImageReviewQueue({
    needsReview: view,
    browsingLevel: level,
    tagIds,
    excludedTagIds,
    userId: csamUserId,
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
    userId: csamUserId ?? null,
  };
}

export type ImageQueueData = Awaited<ReturnType<typeof loadImageQueue>>;

/** `/images/csam?by=user`: the CSAM queue as one row per owning user. */
export async function loadCsamQueueByUser(url: URL) {
  const { level } = parseQuery(url, querySchema);
  const { users, truncated } = await getCsamQueueByUser({ browsingLevel: level });
  return { kind: 'csam-users' as const, level, users, truncated };
}

// accept/block also resolve a coupled report when a `reportId` is posted: accept → Unactioned, block → Actioned.
/** Which of the given reports is on which image. */
async function reportIdsByImage(reportIds: number[]): Promise<Map<number, number[]>> {
  const byImage = new Map<number, number[]>();
  if (!reportIds.length) return byImage;
  const rows = await dbRead
    .selectFrom('ImageReport')
    .select(['imageId', 'reportId'])
    .where('reportId', 'in', reportIds)
    .execute();
  for (const { imageId, reportId } of rows)
    byImage.set(imageId, [...(byImage.get(imageId) ?? []), reportId]);
  return byImage;
}

export function parseResolutionReason(form: FormData, status: ResolutionVerdict<'appeal'>) {
  const input = parseForm(z.object(resolutionReasonFields), form);
  return typeof input === 'string' ? input : checkedResolutionReason('appeal', status, input);
}

export const imageQueueActions = {
  accept: async ({ request, locals }) => {
    const form = await request.formData();
    const imageId = Number(form.get('imageId'));
    if (!imageId) return fail(400, { error: 'Missing image id.' });
    const removeMinorFlag = form.get('removeMinorFlag') === 'true';
    const reportId = form.get('reportId') ? Number(form.get('reportId')) : undefined;

    try {
      await acceptImage({ imageId, removeMinorFlag, userId: locals.user.id });
    } catch (e) {
      if (e instanceof FlagOnlyRemovedError)
        return fail(409, {
          error: `This image was ${FLAG_ONLY_REASON}. ${FLAG_ONLY_REMEDY}`,
          imageId,
        });
      throw e;
    }
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

    const { held } = await blockImage({
      imageId,
      userId: locals.user.id,
      ...violation,
      ...getActorMeta(event),
      reportIds: reportId ? [reportId] : undefined,
      skipAppealCheck: !!locals.grants['image.removal.confirm'],
    });
    // Not removed, so the report stays open; confirming the hold actions it.
    if (held) return { success: true, imageId, held: heldRemovalMessage([held]) };
    if (reportId)
      await setReportStatus({
        id: reportId,
        status: ReportStatus.Actioned,
        userId: locals.user.id,
      });
    return { success: true, imageId };
  },

  // Only from the flag's own queue: the page gate is per path, and every `/images/<view>` queue posts to the one `/images/[slug]` route (`params.slug`); `/reports/image` does not export this verb.
  dismissFlag: async ({ request, locals, params }) => {
    if (params.slug !== FLAG_KEPT_THROUGH_BLOCK) return fail(403, { error: 'Not available here.' });
    const input = parseForm(
      z.object({ imageId: int4Id, version: z.string().min(1) }),
      await request.formData()
    );
    if (typeof input === 'string') return fail(400, { error: input });
    const { imageId } = input;
    const result = await dismissFromCsamQueue({ ...input, userId: locals.user.id });
    if (!result.ok)
      return fail(result.reason === 'unavailable' ? 503 : 409, {
        error:
          result.reason === 'unavailable'
            ? 'Dismissing is not available yet. Nothing was dismissed.'
            : 'This image changed or left this queue since it was shown. Nothing was dismissed. Reload.',
        imageId,
      });
    return { success: true, imageId };
  },

  // `dismissFlag` for every one of one user's removed images, from the by-user view of the same queue.
  dismissUserFlags: async ({ request, locals, params }) => {
    if (params.slug !== FLAG_KEPT_THROUGH_BLOCK) return fail(403, { error: 'Not available here.' });
    const input = parseForm(
      z.object({
        userId: int4Id,
        expectedCount: z.coerce.number().int().positive(),
        version: z.string().min(1),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return fail(400, { error: input });
    const result = await dismissUserFromCsamQueue({ ...input, moderatorId: locals.user.id });
    if (!result.ok)
      return fail(result.reason === 'unavailable' ? 503 : 409, {
        error:
          result.reason === 'unavailable'
            ? 'Dismissing is not available yet. Nothing was dismissed.'
            : `User #${input.userId}'s queue changed since it was shown. Nothing was dismissed. Reload.`,
      });
    return {
      success: true,
      cleared: `Dismissed ${result.dismissed} removed image${
        result.dismissed === 1 ? '' : 's'
      } for user #${input.userId}.${
        result.remaining ? ` ${result.remaining} still need a verdict.` : ''
      }`,
    };
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
    const reason = parseResolutionReason(form, status);
    if (typeof reason === 'string') return fail(400, { error: reason, imageId });

    const closed = await resolveImageAppeal({
      imageId,
      status,
      resolvedMessage,
      ...reason,
      userId: locals.user.id,
    });
    if (!closed)
      return fail(409, {
        error: 'Another moderator already resolved this appeal. Reload.',
        imageId,
      });
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
    const refused: number[] = [];
    // Emails only the appeals this request closed, once per appellant instead of per image.
    const closed = await Promise.all(
      imageIds.map((imageId) =>
        acceptImage({
          imageId,
          removeMinorFlag,
          userId: locals.user.id,
          deferAppealEmail: true,
        }).catch((e) => {
          if (!(e instanceof FlagOnlyRemovedError)) throw e;
          refused.push(imageId);
          return undefined;
        })
      )
    );
    await sendBulkAppealEmails(closedAppellants(imageIds, closed), true);
    // Which report belongs to which image is not posted, so a partial batch moves no report.
    if (refused.length)
      return fail(409, {
        error: [
          `${imageIds.length - refused.length} of ${imageIds.length} accepted.`,
          reportIds.length ? 'No report was moved.' : '',
          `Not accepted (${FLAG_ONLY_REASON}): ${refused.join(', ')}.`,
          FLAG_ONLY_REMEDY,
        ]
          .filter(Boolean)
          .join(' '),
      });
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
    const actor = {
      ...violation,
      ...getActorMeta(event),
      skipAppealCheck: !!locals.grants['image.removal.confirm'],
    };
    const reportsByImage = await reportIdsByImage(reportIds);
    const results = await Promise.all(
      imageIds.map((imageId) =>
        blockImage({
          imageId,
          userId: locals.user.id,
          ...actor,
          reportIds: reportsByImage.get(imageId),
        })
      )
    );
    const held = results.flatMap((r): HeldRemoval[] => (r.held ? [r.held] : []));
    // A held image's reports stay open: it is still up, and confirming the hold actions them.
    const heldReports = new Set(held.flatMap((h) => reportsByImage.get(h.imageId) ?? []));
    await Promise.all(
      reportIds
        .filter((id) => !heldReports.has(id))
        .map((id) => setReportStatus({ id, status: ReportStatus.Actioned, userId: locals.user.id }))
    );
    return {
      success: true,
      ...(held.length && {
        held: heldRemovalMessage(held),
        heldImageIds: held.map((h) => h.imageId),
      }),
    };
  },

  bulkResolveAppeal: async ({ request, locals }) => {
    const form = await request.formData();
    const imageIds = parseIds(form.get('imageIds'));
    const status = form.get('status') === 'Approved' ? 'Approved' : 'Rejected';
    const reason = parseResolutionReason(form, status);
    if (typeof reason === 'string') return fail(400, { error: reason });
    const closed = await Promise.all(
      imageIds.map((imageId) =>
        resolveImageAppeal({
          imageId,
          status,
          ...reason,
          userId: locals.user.id,
          deferAppealEmail: true,
        })
      )
    );
    await sendBulkAppealEmails(closedAppellants(imageIds, closed), status === 'Approved');
    return { success: true };
  },
} satisfies Actions;
