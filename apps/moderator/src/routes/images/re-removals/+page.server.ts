import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad, RequestEvent } from './$types';
import { requiresGrant } from '$lib/server/access';
import { parseForm, parseQuery } from '$lib/server/query';
import {
  REMOVAL_CONFIRMATION_STATUSES,
  confirmRemoval,
  declineRemoval,
  getRemovalConfirmations,
} from '$lib/server/image-removal-confirmation.service';

const LIMIT = 50;

const querySchema = z.object({
  status: z.enum(REMOVAL_CONFIRMATION_STATUSES).catch('Pending'),
});

export const load: PageServerLoad = async ({ url }) => {
  const { status } = parseQuery(url, querySchema);
  const { items, hasMore } = await getRemovalConfirmations({ status, limit: LIMIT });
  return { items, hasMore, limit: LIMIT, status };
};

const decisionSchema = z.object({
  id: z.coerce.number().int().positive(),
  note: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .transform((v) => v || undefined),
});

const decide =
  (run: typeof confirmRemoval) =>
  async ({ request, locals }: RequestEvent) => {
    const input = parseForm(decisionSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    let result: Awaited<ReturnType<typeof run>>;
    try {
      result = await run({ ...input, userId: locals.user.id });
    } catch (e) {
      // Returned, not thrown: an error page would unmount the queue and the note being written.
      console.error('[re-removals] decision failed', { id: input.id, error: e });
      return fail(500, {
        error: 'The removal could not be run. It is still pending.',
        id: input.id,
      });
    }
    if (!result.ok) return fail(409, { error: result.error, id: input.id });
    return { success: true, id: input.id, status: result.status, note: result.note };
  };

export const actions: Actions = {
  confirm: requiresGrant('image.removal.confirm', decide(confirmRemoval)),
  decline: requiresGrant('image.removal.confirm', decide(declineRemoval)),
};
