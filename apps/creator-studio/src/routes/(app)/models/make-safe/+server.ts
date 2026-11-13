import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { callMainApp } from '$lib/server/main-app';
import { assertOwnWrite } from '$lib/server/own-write';
import { sessionCookies } from '$lib/server/session-cookies';

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('draft'), modelId: z.number().int().positive() }),
  z.object({
    action: z.literal('save'),
    modelId: z.number().int().positive(),
    sfwName: z.string().trim().min(1),
    sfwDescription: z.string().nullable(),
    sfwCoverImageId: z.number().int().positive(),
  }),
]);

// Forwards the creator's session; every rule (ownership, locks, checks) lives in the main app endpoint.
export const POST: RequestHandler = async ({ request }) => {
  assertOwnWrite(request);
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) error(400, 'Invalid request');
  const result = await callMainApp<unknown>('/api/v1/models/com-face', sessionCookies(request), {
    method: 'POST',
    body: parsed.data,
    // A draft can run the intent check, two chat completions and two text checks in series.
    timeoutMs: 150_000,
  });
  if (!result.ok) return json({ error: result.error }, { status: result.status });
  return json(result.data);
};
