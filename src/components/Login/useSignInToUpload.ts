import { useCallback } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { openLoginPopup } from '~/utils/auth-helpers';

/** Opens the hub sign-in, returning to the current page, under the generator's login reason. */
export function openSignInToUpload() {
  const here = window.location.pathname + window.location.search + window.location.hash;
  openLoginPopup(here, 'image-gen');
}

/**
 * Generator uploads need a signed-in user: the presign request behind every consumer-blob upload
 * is rejected for a signed-out one. `requireSignIn` opens sign-in and returns true for a signed-out
 * user, and the caller then stops instead of starting the upload. Call it only for an upload the
 * user started (a pick, drop, paste or confirm) — an upload started without a gesture shows a
 * sign-in message instead (`signedOut`), rather than opening a window the user did not ask for.
 */
export function useSignInToUpload() {
  const signedOut = !useCurrentUser();
  const requireSignIn = useCallback(() => {
    if (!signedOut) return false;
    openSignInToUpload();
    return true;
  }, [signedOut]);
  return { signedOut, requireSignIn };
}
