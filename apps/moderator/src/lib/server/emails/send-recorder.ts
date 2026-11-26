import { env } from '$env/dynamic/private';
import { createRemoteSendRecorder, setEmailSendRecorder } from '@civitai/email';
import { logToAxiom } from '$lib/server/axiom';
import { tryCivitaiInternalUrl } from '$lib/server/civitai-url';
import { mainAppHostFetch } from '$lib/server/main-app-fetch';

/**
 * Registers the moderator app's email send recorder: each send's row (its tags and send id, never
 * an address) is POSTed to the main app's internal route (at `CIVITAI_INTERNAL_URL`), which writes it
 * to emailEvents. The credential is `AUTH_INTERNAL_TOKEN`, which the main app also holds; without the
 * token or that URL nothing is recorded. The send never waits on the POST.
 */
export function registerEmailSendRecorder(): boolean {
  const recorder = createRemoteSendRecorder({
    baseUrl: tryCivitaiInternalUrl() ?? '',
    fetch: mainAppHostFetch,
    token: env.AUTH_INTERNAL_TOKEN ?? '',
    onError: (reason) =>
      void logToAxiom({
        type: 'warning',
        name: 'email-events',
        message: 'email send could not be recorded',
        reason,
      }),
  });
  setEmailSendRecorder(recorder);
  return recorder !== null;
}
