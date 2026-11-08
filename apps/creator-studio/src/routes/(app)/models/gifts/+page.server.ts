import { z } from 'zod';
import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { MODEL_GIFT_LINKS_FLAG } from '$lib/gift-links';
import { callMainApp } from '$lib/server/main-app';
import { firstError } from '$lib/server/form-errors';
import { darkFlagEnabled } from '$lib/server/main-app-flags';
import { sessionCookies } from '$lib/server/session-cookies';
import type { GiftIndexPage } from './gift-links';

const versionId = z.coerce.number().int().positive();
const revokeSchema = z.union([
  z.object({ versionId, id: z.coerce.number().int().positive() }),
  z.object({ versionId, batchId: z.uuid() }),
]);

async function assertEnabled(user: App.Locals['user']) {
  if (!(await darkFlagEnabled(MODEL_GIFT_LINKS_FLAG, user))) error(404, 'Not found');
}

export const load: PageServerLoad = async ({ locals, request, url }) => {
  await assertEnabled(locals.user);
  const cursor = url.searchParams.get('cursor');
  const result = await callMainApp<GiftIndexPage>(
    `/api/v1/model-versions/gifts${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    sessionCookies(request)
  );
  return {
    page: result.ok ? result.data : { items: [], nextCursor: null },
    listError: result.ok ? null : result.error,
    paged: !!cursor,
  };
};

export const actions: Actions = {
  // The main app re-checks that the caller may manage this version and that the gift belongs to it.
  revoke: async ({ locals, request }) => {
    await assertEnabled(locals.user);
    const parsed = revokeSchema.safeParse(Object.fromEntries(await request.formData()));
    if (!parsed.success) return fail(400, { error: firstError(parsed.error) });
    const base = `/api/v1/model-versions/${parsed.data.versionId}/gifts`;
    const path =
      'id' in parsed.data ? `${base}/${parsed.data.id}` : `${base}/batch/${parsed.data.batchId}`;
    const result = await callMainApp<{ revoked: number }>(path, sessionCookies(request), {
      method: 'DELETE',
    });
    if (!result.ok) return fail(result.status, { error: result.error });
    return { revoked: result.data.revoked };
  },
};
