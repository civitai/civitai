import type { RequestHandler } from './$types';
import { exchangeCode, sheetCookie } from '$lib/server/held-sheet';
import { auditSheetExchange } from '$lib/server/sheet-audit';

// Reached without a web session: hooks.server.ts lets this one path through, and `locals.user` is unset.
export const POST: RequestHandler = async ({ request }) => {
  const headers = { 'cache-control': 'no-store' };
  const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    auditSheetExchange({ tier: 'held', outcome: 'refused', reason: 'not-json' });
    return new Response(null, { status: 400, headers });
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const result = await exchangeCode(body?.code, body?.code_verifier).catch(() => {
    console.error('[held-sheet] code exchange failed');
    return undefined;
  });
  if (result === undefined) {
    auditSheetExchange({ tier: 'held', outcome: 'error' });
    return new Response(null, { status: 503, headers });
  }
  const { userId: moderatorId, batch } = result;
  if (result.token === null) {
    auditSheetExchange({
      tier: 'held',
      outcome: 'refused',
      reason: result.reason,
      moderatorId,
      batch,
    });
    return new Response(null, { status: 400, headers });
  }
  auditSheetExchange({ tier: 'held', outcome: 'ok', moderatorId, batch });

  return new Response(null, {
    status: 204,
    headers: { ...headers, 'set-cookie': sheetCookie(result.token) },
  });
};
