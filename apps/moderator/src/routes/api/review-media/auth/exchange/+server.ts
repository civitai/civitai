import type { RequestHandler } from './$types';
import {
  exchangeReviewCode,
  REVIEW_SHEET_COOKIE,
  reviewBatchesEnabled,
  reviewCookie,
} from '$lib/server/held-sheet';
import { auditSheetExchange } from '$lib/server/sheet-audit';

// No web session here: hooks.server.ts skips auth for the sheet exchange paths, so `locals.user` is unset.
export const POST: RequestHandler = async ({ request, cookies }) => {
  const headers = { 'cache-control': 'no-store' };
  if (!reviewBatchesEnabled()) return new Response(null, { status: 404, headers });
  const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    auditSheetExchange({ tier: 'general', outcome: 'refused', reason: 'not-json' });
    return new Response(null, { status: 400, headers });
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const result = await exchangeReviewCode(
    body?.code,
    body?.code_verifier,
    cookies.get(REVIEW_SHEET_COOKIE)
  ).catch(() => {
    console.error('[review-sheet] code exchange failed');
    return undefined;
  });
  if (result === undefined) {
    auditSheetExchange({ tier: 'general', outcome: 'error' });
    return new Response(null, { status: 503, headers });
  }
  const { userId: moderatorId, batch } = result;
  if (result.token === null) {
    auditSheetExchange({
      tier: 'general',
      outcome: 'refused',
      reason: result.reason,
      moderatorId,
      batch,
    });
    return new Response(null, { status: 400, headers });
  }
  auditSheetExchange({ tier: 'general', outcome: 'ok', moderatorId, batch });

  return new Response(null, {
    status: 204,
    headers: { ...headers, 'set-cookie': reviewCookie(result.token) },
  });
};
