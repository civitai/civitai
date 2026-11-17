import { z } from 'zod';
import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { GIFT_LINK_MAX_REDEMPTIONS, MODEL_GIFT_LINKS_FLAG } from '$lib/gift-links';
import { dbRead } from '$lib/server/db';
import { callMainApp } from '$lib/server/main-app';
import { firstError } from '$lib/server/form-errors';
import { darkFlagEnabled } from '$lib/server/main-app-flags';
import { sessionCookies } from '$lib/server/session-cookies';
import type { GiftList } from '../gift-links';

const versionIdSchema = z.coerce.number().int().positive();
// The page sends the end of the picked day in the creator's zone. A post that ran before hydration sends
// the bare date, read as the end of that day in UTC.
const optionalDate = z
  .string()
  .optional()
  .transform((v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T23:59:59.999Z` : v || null))
  .pipe(z.iso.datetime().nullable());
const optionalLabel = z
  .string()
  .trim()
  .max(100)
  .optional()
  .transform((v) => v || null);

const createSchema = z.object({
  maxRedemptions: z.coerce.number().int().min(1).max(GIFT_LINK_MAX_REDEMPTIONS),
  expiresAt: optionalDate,
  label: optionalLabel,
});
const mintSchema = z.object({
  count: z.coerce.number().int().min(1).max(500),
  expiresAt: optionalDate,
  label: optionalLabel,
});
const revokeSchema = z.union([
  z.object({ id: z.coerce.number().int().positive() }),
  z.object({ batchId: z.uuid() }),
]);

async function versionOrThrow(versionId: string, user: App.Locals['user']) {
  const id = versionIdSchema.safeParse(versionId);
  if (!id.success) error(404, 'Not found');
  if (!(await darkFlagEnabled(MODEL_GIFT_LINKS_FLAG, user))) error(404, 'Not found');
  const version = await dbRead
    .selectFrom('ModelVersion as mv')
    .innerJoin('Model as m', 'm.id', 'mv.modelId')
    .select([
      'mv.id',
      'mv.name',
      'm.id as modelId',
      'm.name as modelName',
      'm.userId',
      'm.nsfw',
      'm.nsfwLevel',
    ])
    .where('mv.id', '=', id.data)
    .executeTakeFirst();
  // The main app re-checks ownership on every call; this only keeps the page from rendering.
  if (!version || (version.userId !== user.id && !user.isModerator)) error(404, 'Not found');
  return version;
}

export const load: PageServerLoad = async ({ params, locals, request }) => {
  const version = await versionOrThrow(params.versionId, locals.user);
  const result = await callMainApp<GiftList>(
    `/api/v1/model-versions/${version.id}/gifts`,
    sessionCookies(request)
  );
  return {
    version,
    gifts: result.ok ? result.data : { links: [], batches: [] },
    listError: result.ok ? null : result.error,
  };
};

export const actions: Actions = {
  createLink: async ({ params, locals, request }) => {
    const version = await versionOrThrow(params.versionId, locals.user);
    const parsed = createSchema.safeParse(Object.fromEntries(await request.formData()));
    if (!parsed.success) return fail(400, { error: firstError(parsed.error) });
    const result = await callMainApp<{ id: number; code: string }>(
      `/api/v1/model-versions/${version.id}/gifts/link`,
      sessionCookies(request),
      { method: 'POST', body: parsed.data }
    );
    if (!result.ok) return fail(result.status, { error: result.error });
    return { created: { codes: [result.data.code], batchId: null } };
  },
  mint: async ({ params, locals, request }) => {
    const version = await versionOrThrow(params.versionId, locals.user);
    const parsed = mintSchema.safeParse(Object.fromEntries(await request.formData()));
    if (!parsed.success) return fail(400, { error: firstError(parsed.error) });
    const result = await callMainApp<{ batchId: string; codes: string[] }>(
      `/api/v1/model-versions/${version.id}/gifts`,
      sessionCookies(request),
      { method: 'POST', body: parsed.data }
    );
    if (!result.ok) return fail(result.status, { error: result.error });
    return { created: { codes: result.data.codes, batchId: result.data.batchId } };
  },
  revoke: async ({ params, locals, request }) => {
    const version = await versionOrThrow(params.versionId, locals.user);
    const parsed = revokeSchema.safeParse(Object.fromEntries(await request.formData()));
    if (!parsed.success) return fail(400, { error: firstError(parsed.error) });
    const path =
      'id' in parsed.data
        ? `/api/v1/model-versions/${version.id}/gifts/${parsed.data.id}`
        : `/api/v1/model-versions/${version.id}/gifts/batch/${parsed.data.batchId}`;
    const result = await callMainApp<{ revoked: number }>(path, sessionCookies(request), {
      method: 'DELETE',
    });
    if (!result.ok) return fail(result.status, { error: result.error });
    return { revoked: result.data.revoked };
  },
};
