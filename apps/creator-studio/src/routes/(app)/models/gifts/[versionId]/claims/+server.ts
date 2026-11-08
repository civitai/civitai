import { z } from 'zod';
import { error, json, type RequestHandler } from '@sveltejs/kit';
import { MODEL_GIFT_LINKS_FLAG } from '$lib/gift-links';
import { callMainApp } from '$lib/server/main-app';
import { darkFlagEnabled } from '$lib/server/main-app-flags';
import { sessionCookies } from '$lib/server/session-cookies';
import type { GiftClaimsPage } from '../../gift-links';

const querySchema = z.object({
  versionId: z.coerce.number().int().positive(),
  target: z.union([
    z.object({ giftId: z.coerce.number().int().positive() }),
    z.object({ batchId: z.uuid() }),
  ]),
  cursor: z.string().min(1).max(200).optional(),
});

// The claimers of one link or batch. The main app checks that the caller may manage the version.
export const GET: RequestHandler = async ({ params, url, locals, request }) => {
  if (!(await darkFlagEnabled(MODEL_GIFT_LINKS_FLAG, locals.user))) error(404, 'Not found');
  const parsed = querySchema.safeParse({
    versionId: params.versionId,
    target: Object.fromEntries(
      ['giftId', 'batchId'].flatMap((k) =>
        url.searchParams.has(k) ? [[k, url.searchParams.get(k)]] : []
      )
    ),
    cursor: url.searchParams.get('cursor') ?? undefined,
  });
  if (!parsed.success) error(400, 'Invalid request');
  const { versionId, target, cursor } = parsed.data;
  const path =
    'giftId' in target
      ? `/api/v1/model-versions/${versionId}/gifts/${target.giftId}/claims`
      : `/api/v1/model-versions/${versionId}/gifts/batch/${target.batchId}/claims`;
  const result = await callMainApp<GiftClaimsPage>(
    `${path}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    sessionCookies(request)
  );
  if (!result.ok) error(result.status, result.error);
  return json(result.data);
};
