import { z } from 'zod';
import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { MODEL_GIFT_LINKS_FLAG } from '$lib/gift-links';
import { callMainApp } from '$lib/server/main-app';
import { firstError } from '$lib/server/form-errors';
import { darkFlagEnabled } from '$lib/server/main-app-flags';
import { sessionCookies } from '$lib/server/session-cookies';
import { loadUsageLimits, USAGE_LIMITS_URL } from '$lib/server/usage-limits';
import type { GiftIndexPage } from './gift-links';

const versionId = z.coerce.number().int().positive();
const revokeSchema = z.union([
  z.object({ versionId, id: z.coerce.number().int().positive() }),
  z.object({ versionId, batchId: z.uuid() }),
]);

async function assertEnabled(user: App.Locals['user']) {
  if (!(await darkFlagEnabled(MODEL_GIFT_LINKS_FLAG, user))) error(404, 'Not found');
}

// Set by a revoke, so the load that re-runs right after it reads the primary instead of the replica.
const FRESH_COOKIE = 'cs-gifts-fresh';

export const load: PageServerLoad = async ({ locals, request, url, cookies }) => {
  await assertEnabled(locals.user);
  const query = new URLSearchParams();
  const cursor = url.searchParams.get('cursor');
  if (cursor) query.set('cursor', cursor);
  if (cookies.get(FRESH_COOKIE)) {
    query.set('fresh', '1');
    cookies.delete(FRESH_COOKIE, { path: '/models/gifts' });
  }
  const qs = query.toString();
  const cookie = sessionCookies(request);
  // Streamed, so a slow limits read never holds up the list.
  const giftLimit = loadUsageLimits(cookie).then(
    (limits) => limits?.find((row) => row.id === 'gifts.monthly') ?? null
  );
  const result = await callMainApp<GiftIndexPage>(
    `/api/v1/model-versions/gifts${qs ? `?${qs}` : ''}`,
    cookie
  );
  return {
    page: result.ok ? result.data : { items: [], nextCursor: null },
    listError: result.ok ? null : result.error,
    paged: !!cursor,
    // How many times this creator's links were claimed this month, of their limit; null when the
    // read failed or the main app lists no such row, and the card then does not draw.
    giftLimit,
    usageLimitsUrl: USAGE_LIMITS_URL,
  };
};

export const actions: Actions = {
  // The main app re-checks that the caller may manage this version and that the gift belongs to it.
  revoke: async ({ locals, request, cookies }) => {
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
    cookies.set(FRESH_COOKIE, '1', { path: '/models/gifts', maxAge: 30, httpOnly: true });
    return { revoked: result.data.revoked };
  },
};
