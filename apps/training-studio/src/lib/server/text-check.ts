import {
  TrainingTextCheckError,
  TrainingTextRefusedError,
  type TrainingTextCheck,
} from '$lib/training-text';
import { logToAxiom } from './axiom';
import { mainAppSessionOrigin } from './main-app';

const CHECK_TIMEOUT_MS = 15_000;

type Answer = { ok?: unknown; message?: string; error?: string } | null;

/**
 * The main app's trigger word check, called as this user: their shared .civitai.com session cookie
 * is forwarded verbatim, which is what authenticates the request. Only an explicit `{ ok: true }`
 * passes; a refusal throws `TrainingTextRefusedError`, anything else `TrainingTextCheckError`.
 */
export function mainAppTextCheck(cookie: string, userId: number): TrainingTextCheck {
  return async (input) => {
    let status: number | undefined;
    let data = null as Answer;
    /** Why the request itself failed; logged, never shown, as it can name configuration. */
    let failure: string | undefined;
    // A refusal's reason arrives as `message`; the route's answer to a malformed body uses `error`.
    const detail = () => data?.message ?? data?.error;
    const reason = () => detail() ?? `The trigger word check failed (${status ?? 'unreachable'}).`;
    try {
      const res = await fetch(`${mainAppSessionOrigin()}/api/training-studio/check-text`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(input),
        redirect: 'error',
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      status = res.status;
      data = (await res.json().catch(() => null)) as Answer;
      if (res.ok && data?.ok === true) return;
      if (status === 400) throw new TrainingTextRefusedError(detail() ?? 'Refused.');
    } catch (err) {
      if (err instanceof TrainingTextRefusedError) throw err;
      failure = (err as Error)?.message;
      data = null;
      status = undefined;
    }
    logToAxiom({
      name: 'training-studio-text-check',
      type: 'error',
      userId,
      status,
      message: failure ?? detail(),
    });
    throw new TrainingTextCheckError(reason(), status);
  };
}

/** The check for one request: the main app's, sent with the caller's cookie — or none in the
 *  dev-login preview (`cookie` null), which has no session to send it with. */
export function requestTextCheck(cookie: string | null, userId: number): TrainingTextCheck {
  return cookie === null ? async () => undefined : mainAppTextCheck(cookie, userId);
}
