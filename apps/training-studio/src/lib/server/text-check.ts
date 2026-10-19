import {
  TrainingTextCheckError,
  TrainingTextRefusedError,
  type TrainingTextCheck,
} from '$lib/training-text';
import { logToAxiom } from './axiom';
import { mainAppSessionOrigin } from './main-app';

/** Long enough to classify a dataset at the main app's text cap. */
const CHECK_TIMEOUT_MS = 120_000;

type Answer = { ok?: unknown; message?: string; error?: string } | null;

/**
 * The main app's training text rule, called as this user: their shared .civitai.com session cookie
 * is forwarded verbatim, which is what authenticates the request. Only an explicit `{ ok: true }`
 * passes; a refusal throws `TrainingTextRefusedError`, anything else `TrainingTextCheckError`.
 */
export function mainAppTextCheck(cookie: string, userId: number): TrainingTextCheck {
  return async (input) => {
    let status: number | undefined;
    let data = null as Answer;
    // A refusal's reason arrives as `message`; the route's own answers (413, 429) use `error`.
    const detail = () => data?.message ?? data?.error;
    const reason = () => detail() ?? `The training text check failed (${status ?? 'unreachable'}).`;
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
      data = { error: (err as Error)?.message };
      status = undefined;
    }
    logToAxiom({
      name: 'training-studio-text-check',
      type: 'error',
      userId,
      status,
      message: detail(),
    });
    throw new TrainingTextCheckError(reason(), status);
  };
}
