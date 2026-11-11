import type { RequestHandler } from './$types';
import { exchangeCode, sheetCookie } from '$lib/server/held-sheet';

// Reached without a web session: hooks.server.ts lets this one path through, and `locals.user` is unset.
export const POST: RequestHandler = async ({ request }) => {
  const headers = { 'cache-control': 'no-store' };
  const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return new Response(null, { status: 400, headers });

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const token = await exchangeCode(body?.code, body?.code_verifier).catch(() => {
    console.error('[held-sheet] code exchange failed');
    return undefined;
  });
  if (token === undefined) return new Response(null, { status: 503, headers });
  if (!token) return new Response(null, { status: 400, headers });

  return new Response(null, {
    status: 204,
    headers: { ...headers, 'set-cookie': sheetCookie(token) },
  });
};
