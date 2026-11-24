import { env } from '$env/dynamic/private';
import { createRemoteSendRecorder, setEmailSendRecorder } from '@civitai/email';
import { logToAxiom } from '$lib/server/axiom';

/**
 * Registers the hub's email send recorder: each send's row (its tags and send id, never an address)
 * is POSTed to the main app's internal route, which writes it to emailEvents. The hub has no
 * ClickHouse access of its own. The main app is `CIVITAI_APP_URL`, and only that: the credential
 * sent there is `AUTH_INTERNAL_TOKEN` (which the main app also holds), so it never follows a
 * user-redirect setting such as AUTH_DEFAULT_RETURN_URL to another host. Without either nothing is
 * recorded. The send never waits on the POST.
 */
export function registerEmailSendRecorder(): boolean {
  const recorder = createRemoteSendRecorder({
    baseUrl: env.CIVITAI_APP_URL ?? '',
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
