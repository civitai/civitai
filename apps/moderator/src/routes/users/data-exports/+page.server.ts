import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { requireAccess, requiresGrant } from '$lib/server/access';
import { int4Id, parseForm, parseQuery } from '$lib/server/query';
import {
  EXPORT_STATUSES,
  listPersonalDataExports,
  queuePersonalDataExport,
  releasePersonalDataExport,
} from '$lib/server/personal-data-export.service';
import { dashboardQueueSchema } from '$lib/server/personal-data-export-form';
import { ALREADY_QUEUED } from '$lib/server/tickets/export-write';

const querySchema = z.object({
  status: z.enum(EXPORT_STATUSES).optional().catch(undefined),
});

export const load: PageServerLoad = async ({ locals, url }) => {
  requireAccess(locals.user, url.pathname);
  const { status } = parseQuery(url, querySchema);
  return {
    status: status ?? null,
    statuses: EXPORT_STATUSES,
    exports: await listPersonalDataExports({ status, limit: 200 }),
    canQueue: !!locals.grants['user.personalDataExport.queue'],
    canRelease: !!locals.grants['user.personalDataExport.release'],
  };
};

export const actions: Actions = {
  queue: requiresGrant('user.personalDataExport.queue', async ({ request, locals }) => {
    const input = parseForm(dashboardQueueSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    const result = await queuePersonalDataExport({
      userId: input.userId,
      requestedById: locals.user.id,
      ticketId: null,
      requestedAt: input.requestedAt,
    });
    if (result.status === 'already-queued') return fail(409, { error: ALREADY_QUEUED });
    if (result.status === 'no-user') return fail(404, { error: `No user ${input.userId}.` });
    if (result.status === 'error')
      return fail(500, { error: 'Could not queue the export; nothing was queued. Try again.' });
    return { success: true as const, id: result.id };
  }),

  release: requiresGrant('user.personalDataExport.release', async ({ request }) => {
    const input = parseForm(z.object({ exportId: int4Id }), await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    const result = await releasePersonalDataExport(input.exportId);
    if (!result.ok) return fail(400, { error: result.error });
    return { success: true as const, linkExpiresAt: result.linkExpiresAt };
  }),
};
