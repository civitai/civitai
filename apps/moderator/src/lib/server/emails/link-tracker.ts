import { env } from '$env/dynamic/private';
import { createRemoteLinkTracker, setEmailLinkTracker } from '@civitai/email';
import { logToAxiom } from '$lib/server/axiom';
import { civitaiAppUrl } from '$lib/server/civitai-url';

/**
 * Registers the moderator app's email link tracker: at render, each email's web links are sent to
 * the main app's internal route (at `civitaiAppUrl()`), which signs its same-site ones for the
 * click redirect. This app holds no signing key; the credential is `AUTH_INTERNAL_TOKEN`, the same
 * one its send rows use. Without it, or when the call fails or takes longer than 2 s, the email is
 * sent with its links as written.
 */
export function registerEmailLinkTracker(): boolean {
  const tracker = createRemoteLinkTracker({
    baseUrl: civitaiAppUrl(),
    token: env.AUTH_INTERNAL_TOKEN ?? '',
    onError: (reason) =>
      void logToAxiom({
        type: 'warning',
        name: 'email-links',
        message: 'email links went out untracked',
        reason,
      }),
  });
  setEmailLinkTracker(tracker);
  return tracker !== null;
}
