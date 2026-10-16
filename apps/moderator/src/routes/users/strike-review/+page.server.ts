import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { requireAccess, requiresGrant } from '$lib/server/access';
import { banFieldsSchema, banRemovalArgs, rejectUnexplainedOther } from '$lib/server/ban-input';
import { parseForm } from '$lib/server/query';
import {
  activeStrikeOwner,
  clearStrikeReviewFlag,
  getStrikeReviewQueue,
  isInStrikeReview,
  STRIKE_REVIEW_LIMIT,
} from '$lib/server/strike-review.service';
import { banConfirmed, setBanned, setMuted, voidStrike } from '$lib/server/user-actions.service';

const userIdField = { userId: z.coerce.number().int().positive() };

// Every action resolves its subject against the queue on the primary. `audit.ban.execute` and this page's
// grant reach no other account page, so an edited form must not turn them into a way to act on anyone.
const NOT_QUEUED = 'This account is no longer in the strike review queue. Reload the page.';

export const load: PageServerLoad = async ({ url, locals }) => {
  requireAccess(locals.user, url.pathname);
  const { rows, total } = await getStrikeReviewQueue();
  return { rows, total, limit: STRIKE_REVIEW_LIMIT };
};

export const actions: Actions = {
  ban: requiresGrant('audit.ban.execute', async ({ request, locals }) => {
    const input = parseForm(banFieldsSchema.extend(userIdField), await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    const unexplained = rejectUnexplainedOther(input);
    if (unexplained) return fail(400, { error: unexplained });
    if (!(await isInStrikeReview(input.userId))) return fail(409, { error: NOT_QUEUED });

    const result = await setBanned({
      userId: input.userId,
      ban: true,
      reasonCode: input.reasonCode,
      detailsInternal: input.detailsInternal || undefined,
      detailsExternal: input.detailsExternal || undefined,
      ...banRemovalArgs(input, true),
      moderatorId: locals.user.id,
    });
    if (!result.ok) return fail(400, { error: result.error });

    // `/api/mod/ban-user` answers before the ban is written, so a 200 alone would drop the row from a
    // reload that still shows it.
    if (!(await banConfirmed(input.userId)))
      return fail(502, {
        error: 'The ban was accepted but has not taken effect yet. Reload and check the account.',
      });
    return { success: true };
  }),

  unmute: async ({ request, locals }) => {
    const input = parseForm(z.object(userIdField), await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    if (!(await isInStrikeReview(input.userId))) return fail(409, { error: NOT_QUEUED });

    const result = await setMuted({
      userId: input.userId,
      muted: false,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return fail(400, { error: result.error });
    await clearStrikeReviewFlag(input.userId);
    return { success: true };
  },

  voidStrike: async ({ request, locals }) => {
    const input = parseForm(
      z.object({
        strikeId: z.coerce.number().int().positive(),
        voidReason: z.string().trim().min(1, 'A reason is required.').max(1000),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return fail(400, { error: input });

    const userId = await activeStrikeOwner(input.strikeId);
    if (userId == null)
      return fail(409, { error: 'That strike is no longer active. Reload the page.' });
    if (!(await isInStrikeReview(userId))) return fail(409, { error: NOT_QUEUED });

    const result = await voidStrike({
      strikeId: input.strikeId,
      voidReason: input.voidReason,
      userId,
      moderatorId: locals.user.id,
    });
    return result.ok ? { success: true } : fail(400, { error: result.error });
  },
};
