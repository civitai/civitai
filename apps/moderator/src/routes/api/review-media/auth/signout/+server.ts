import type { RequestHandler } from './$types';
import {
  clearedReviewCookie,
  REVIEW_SHEET_COOKIE,
  revokeReviewSession,
} from '$lib/server/held-sheet';
import { auditSheetSignout } from '$lib/server/sheet-audit';

// No web session here: hooks.server.ts skips auth for this POST. The cookie can end only the
// session it names. A failure keeps the cookie, so the sheet can try again.
export const POST: RequestHandler = async ({ cookies }) => {
  const ended = await revokeReviewSession(cookies.get(REVIEW_SHEET_COOKIE)).then(
    (moderatorId) => {
      auditSheetSignout({ moderatorId, ended: moderatorId !== null });
      return true;
    },
    () => {
      console.error('[review-sheet] sign out failed');
      auditSheetSignout({ moderatorId: null, ended: false, error: true });
      return false;
    }
  );
  return new Response(null, {
    status: ended ? 204 : 503,
    headers: {
      'cache-control': 'no-store',
      ...(ended && { 'set-cookie': clearedReviewCookie() }),
    },
  });
};
