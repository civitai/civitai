import { fail, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { canAccess } from '$lib/server/access';
import { moderateArticle } from '$lib/server/article-moderation';
import { reportModerationActions } from '$lib/server/report-actions';
import { getReportedEntityId } from '$lib/server/reports.service';
import { parseForm } from '$lib/server/query';
import { MAX_INT4 } from '$lib/server/users.service';
import { isArticleUnpublishReason } from '$lib/article-unpublish-reasons';
import { ReportEntity, reportPath } from '$lib/reports';

// The forms of every shared-layout queue, taken by both pages that render an item — the bare queue and
// `[id]`: ruling on a report, the item's images, and a strike or notification for the account (the
// shared report actions: the report on the Reports grant, the images and the account on their action
// grants, as on the user and post queues), plus what only one type has. A type's own action refuses on any other queue: the form posts to whichever queue is open.

type Event = RequestEvent<{ queue: string }>;
// The main site lets any moderator unpublish an article (`isOwnerOrModerator`), so this asks no more
// than reaching the queue does.
const ARTICLE_GATE = reportPath(ReportEntity.Article);

// The form names a REPORT, and the article is read from it, as the model queue's `moderateModel`
// does: a stale tab or a hand-built POST must not unpublish one article while a moderator believes
// they are looking at another, nor any article nobody reported.
const reportId = z.object({ reportId: z.coerce.number().int().positive().max(MAX_INT4) });

const refused = (event: Event) =>
  event.params.queue !== 'article' || !canAccess(event.locals.user, ARTICLE_GATE);

export const entityQueueActions = {
  // Every type here sits under `/reports`, which is one shared grant.
  ...reportModerationActions('/reports'),

  /** The site's moderator unpublish: always as a violation, with the reason the author is shown. */
  unpublishArticle: async (event: Event) => {
    if (refused(event)) return fail(403, { scope: 'article', error: 'Not permitted.' });
    const form = await event.request.formData();
    const input = parseForm(
      reportId.extend({
        reason: z.string().refine(isArticleUnpublishReason, 'Pick a reason.'),
        customMessage: z.string().trim().max(1000).optional(),
      }),
      form
    );
    if (typeof input === 'string') return fail(400, { scope: 'article', error: input });
    // `other` has no wording of its own, so the message IS the reason the author reads.
    if (input.reason === 'other' && !input.customMessage)
      return fail(400, { scope: 'article', error: 'Say what is wrong when the reason is Other.' });

    const articleId = await getReportedEntityId('article', input.reportId);
    if (!articleId)
      return fail(410, { scope: 'article', error: 'That report no longer names an article.' });

    const result = await moderateArticle({
      action: 'unpublish',
      articleId,
      userId: event.locals.user.id,
      reason: input.reason,
      customMessage: input.customMessage || null,
    });
    if (!result.ok) return fail(409, { scope: 'article', error: result.error });
    return { success: true };
  },
};
