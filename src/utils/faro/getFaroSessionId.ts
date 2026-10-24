import { faro } from '@grafana/faro-web-sdk';
import { FEEDBACK_SESSION_ID_MAX_LENGTH } from '~/shared/constants/feedback.constants';

/**
 * The current Grafana Faro session id, or `undefined`.
 *
 * 🔴 ABSENCE IS THE ORDINARY CASE, NOT AN ERROR. `FaroProvider` only calls
 * `initializeFaro` when the build-arg, the collector URL and the `faro` feature
 * flag all agree, so Faro is NOT running in dev, test or preview, and in
 * production it is still absent for anyone whose session was not sampled or whose
 * browser blocked the SDK. Until `initializeFaro` runs, the SDK's `faro` export is
 * a bare `{}` — `faro.api` is `undefined` — which is why every hop below is
 * optional-chained rather than guarded by an "is Faro up?" flag.
 *
 * This returns a value; it never throws. A caller that treats a missing session id
 * as a failure would make feedback unsubmittable on every non-production build,
 * which is the exact bug this shape exists to prevent.
 *
 * The result is truncated to the boundary schema's own bound. The truncation is a
 * belt-and-braces measure and should never fire: a Faro session id is a short
 * opaque string. It is here so a future SDK that lengthens the id degrades to a
 * clipped id instead of a rejected submission.
 */
export function getFaroSessionId(): string | undefined {
  try {
    const id = faro?.api?.getSession?.()?.id;
    if (typeof id !== 'string') return undefined;
    const trimmed = id.trim();
    if (!trimmed) return undefined;
    return trimmed.slice(0, FEEDBACK_SESSION_ID_MAX_LENGTH);
  } catch {
    // A partially-initialised or paused SDK is still "no session id", not a crash.
    return undefined;
  }
}
