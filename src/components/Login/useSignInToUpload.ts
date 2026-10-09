import { useCallback } from 'react';
import { openLoginHere } from '~/components/Login/requireLogin';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useSession } from '~/providers/SessionProvider';

/** Opens sign-in for an upload, returning to the current page, under the upload's own login reason. */
export function openSignInToUpload() {
  openLoginHere('image-upload');
}

/**
 * Generator uploads need a signed-in user: the presign request behind every consumer-blob upload
 * is rejected for a signed-out one. `requireSignIn` opens sign-in and returns true for a signed-out
 * user, and the caller then stops instead of starting the upload. Call it only for an upload the
 * user started (a pick, drop, paste or confirm) — an upload started without a gesture shows a
 * sign-in message instead (`signedOut`), rather than opening a window the user did not ask for.
 *
 * The event-free counterpart of `requireLogin`, which needs a UI event that drop, crop and drawing
 * callbacks do not have. While the session is still loading nobody counts as signed out, so a
 * signed-in user's upload is never refused early; a real signed-out upload in that window gets the
 * sign-in message from the refused presign request instead (`consumer-blob-upload`).
 */
export function useSignInToUpload() {
  const currentUser = useCurrentUser();
  const { status } = useSession();
  const signedOut = !currentUser && status !== 'loading';
  const requireSignIn = useCallback(() => {
    if (!signedOut) return false;
    openSignInToUpload();
    return true;
  }, [signedOut]);
  return { signedOut, requireSignIn };
}
