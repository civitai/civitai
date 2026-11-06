import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
  getRemovedAppeals,
  parseRemovedAppealRuling,
  resolveRemovedAppeal,
} from '$lib/server/removed-appeals.service';

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
    const ruling = parseRemovedAppealRuling(form);
    if (typeof ruling === 'string') return fail(400, { error: ruling, appealId });

    const closed = await resolveRemovedAppeal({
      appealId,
      decision: ruling.status,
      resolvedMessage: ruling.resolvedMessage,
      resolvedReason: ruling.resolvedReason,
      internalNotes: ruling.internalNotes,
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
