import { env } from '$env/dynamic/private';
import { createRemoteSendRecorder, setEmailSendRecorder } from '@civitai/email';
import { logToAxiom } from '$lib/server/axiom';

/**
 * Registers the hub's email send recorder: each send's row (its tags and send id, never an address)
 * is POSTed to the main app's internal route, which writes it to emailEvents. The hub has no
 * ClickHouse access of its own. The main app is `CIVITAI_APP_URL`, else `AUTH_DEFAULT_RETURN_URL`
 * (the main app's public origin); the credential is `AUTH_INTERNAL_TOKEN`, which the main app also
 * holds. Without either nothing is recorded. The send never waits on the POST.
 */
export function registerEmailSendRecorder(): boolean {
  const recorder = createRemoteSendRecorder({
    baseUrl: env.CIVITAI_APP_URL || env.AUTH_DEFAULT_RETURN_URL || '',
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
