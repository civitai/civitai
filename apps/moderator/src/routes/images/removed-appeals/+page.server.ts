import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { parseForm } from '$lib/server/query';
import { checkedResolutionReason, resolutionReasonFields } from '$lib/server/resolution-reason';
import { getRemovedAppeals, resolveRemovedAppeal } from '$lib/server/removed-appeals.service';

const LIMIT = 100;

export const load: PageServerLoad = async () => {
  const { items, hasMore } = await getRemovedAppeals({ limit: LIMIT });
  return { items, hasMore, limit: LIMIT };
};

const ALREADY_DECIDED = 'Another moderator already resolved this appeal. Reload.';

const appealIdOf = (form: FormData) => {
  const appealId = Number(form.get('appealId'));
  return appealId > 0 ? appealId : null;
};

export const actions: Actions = {
  resolve: async ({ request, locals }) => {
    const form = await request.formData();
    const appealId = appealIdOf(form);
    if (!appealId) return fail(400, { error: 'Missing appeal id.' });
    const status = form.get('status') === 'Approved' ? 'Approved' : 'Rejected';
    const resolvedMessage =
      String(form.get('resolvedMessage') ?? '')
        .trim()
        .slice(0, 1000) || undefined;
    const input = parseForm(z.object(resolutionReasonFields), form);
    const reason =
      typeof input === 'string' ? input : checkedResolutionReason('appeal', status, input);
    if (typeof reason === 'string') return fail(400, { error: reason, appealId });

    const closed = await resolveRemovedAppeal({
      appealId,
      decision: status,
      resolvedMessage,
      ...reason,
      moderatorId: locals.user.id,
    });
    if (!closed) return fail(409, { error: ALREADY_DECIDED, appealId });
    return { success: true, appealId, refundFailed: closed.refundFailed };
  },

  ownerDeleted: async ({ request, locals }) => {
    const form = await request.formData();
    const appealId = appealIdOf(form);
    if (!appealId) return fail(400, { error: 'Missing appeal id.' });

    const closed = await resolveRemovedAppeal({
      appealId,
      decision: 'OwnerDeleted',
      moderatorId: locals.user.id,
    });
    if (!closed) return fail(409, { error: ALREADY_DECIDED, appealId });
    return { success: true, appealId, refundFailed: closed.refundFailed };
  },
};
