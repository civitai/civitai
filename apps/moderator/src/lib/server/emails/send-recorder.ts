import { env } from '$env/dynamic/private';
import { createRemoteSendRecorder, setEmailSendRecorder } from '@civitai/email';
import { logToAxiom } from '$lib/server/axiom';
import { civitaiAppUrl } from '$lib/server/civitai-url';

/**
 * Registers the moderator app's email send recorder: each send's row (its tags and send id, never
 * an address) is POSTed to the main app's internal route (at `civitaiAppUrl()`), which writes it to
 * emailEvents. The credential is `AUTH_INTERNAL_TOKEN`, which the main app also holds; without it
 * nothing is recorded. The send never waits on the POST.
 */
export function registerEmailSendRecorder(): boolean {
  const recorder = createRemoteSendRecorder({
    baseUrl: civitaiAppUrl(),
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
