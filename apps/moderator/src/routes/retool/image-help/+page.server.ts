import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { env } from '$env/dynamic/private';
import type { Actions, PageServerLoad } from './$types';
import { canAccess } from '$lib/server/access';
import { parseForm, parseQuery } from '$lib/server/query';
import {
  getHelpRequestImages,
  getOpenHelpRequests,
  resolveHelpRequest,
} from '$lib/server/image-help.service';

const querySchema = z.object({ request: z.coerce.number().int().positive().optional().catch(undefined) });

export const load: PageServerLoad = async ({ url, locals }) => {
  const { request } = parseQuery(url, querySchema);
  const requests = await getOpenHelpRequests();

  // Default to the oldest open request: the queue is drained in order, and landing on an empty right
  // pane makes the page look broken when there is work waiting.
  const selectedId = request ?? requests[0]?.id;
  const selected = requests.find((r) => r.id === selectedId) ?? null;
  const images = selected ? await getHelpRequestImages(selected.id) : [];

  return {
    requests,
    selected,
    images,
    canAct: canAccess(locals.user, '/images'),
    civitaiUrl: env.CIVITAI_APP_URL ?? 'https://civitai.com',
    // Queue left, the request's images right — two columns need the full content width.
    wide: true,
  };
};

export const actions: Actions = {
  resolve: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/images')) return fail(400, { error: 'Not permitted.' });
    const input = parseForm(
      z.object({ requestId: z.coerce.number().int().positive() }),
      await request.formData()
    );
    if (typeof input === 'string') return fail(400, { error: input });

    const result = await resolveHelpRequest({
      requestId: input.requestId,
      // The column is TEXT holding a name, not an id — see the service.
      handledBy: locals.user.username ?? String(locals.user.id),
    });
    if (!result.ok)
      return fail(400, { error: 'Already handled by someone else — reload to see the current queue.' });

    return { success: true, resolved: input.requestId };
  },
};
