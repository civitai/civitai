import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { getLogger } from '$lib/server/logger';
import type { RequestHandler } from './$types';

// Bounded so a hot error loop can't post unbounded payloads; the client already truncates.
const clientErrorSchema = z.object({
  route: z.string().max(200).nullish(),
  url: z.string().max(2000),
  status: z.number().int(),
  message: z.string().max(500),
  stack: z.string().max(4000).optional(),
});

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return json({ ok: false }, { status: 401 });

  const parsed = clientErrorSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ ok: false }, { status: 400 });

  await getLogger().logToAxiom({
    name: 'creator-studio-client-error',
    userId: locals.user.id,
    ...parsed.data,
  });

  return json({ ok: true });
};
