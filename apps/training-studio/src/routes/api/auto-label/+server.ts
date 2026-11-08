import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { mainAppAutoLabelSubmit } from '$lib/server/main-app-autolabel';
import { textCheckCookie } from '$lib/server/text-check';

export const POST: RequestHandler = async ({ locals, request }) => {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !Array.isArray(body.items)) error(400, 'Invalid auto-label request.');
  const { items, mode, media } = body as unknown as Parameters<typeof mainAppAutoLabelSubmit>[2];
  return json(
    await mainAppAutoLabelSubmit(textCheckCookie(locals, request), locals.user.id, {
      items,
      mode,
      media,
    })
  );
};
