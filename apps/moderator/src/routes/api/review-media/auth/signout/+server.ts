import type { RequestHandler } from './$types';
import {
  clearedReviewCookie,
  REVIEW_SHEET_COOKIE,
  revokeReviewSession,
} from '$lib/server/held-sheet';

// The general sheet's Sign out: ends the review session the cookie names on the server, not only
// the phone's copy. No web session here (hooks.server.ts skips auth for this path); the cookie can
// end only the session it names.
export const POST: RequestHandler = async ({ cookies }) => {
  const headers = { 'cache-control': 'no-store', 'set-cookie': clearedReviewCookie() };
  const ended = await revokeReviewSession(cookies.get(REVIEW_SHEET_COOKIE)).then(
    () => true,
    () => {
      console.error('[review-sheet] sign out failed');
      return false;
    }
  );
  return new Response(null, { status: ended ? 204 : 503, headers });
};
