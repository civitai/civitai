import { faro } from '@grafana/faro-web-sdk';
import { FEEDBACK_SESSION_ID_MAX_LENGTH } from '~/shared/constants/feedback.constants';

/**
 * The current Grafana Faro session id, or `undefined`.
 *
 * 🔴 ABSENCE IS THE ORDINARY CASE, NOT AN ERROR. `FaroProvider` only calls
 * `initializeFaro` when the build-arg, the collector URL and the `faro` feature
 * flag all agree, so Faro is NOT running in dev, test or preview, and in
 * production it is still absent for anyone whose browser blocked the SDK. Until
 * `initializeFaro` runs, the SDK's `faro` export is
 * `{ api: <no-op API> }` with no `config` (faro-core 2.8.2 `registerFaro`): the no-op
 * `getSession()` returns `undefined`, so this yields `undefined` with no "is Faro up?"
 * flag. The hops stay optional-chained in case a future SDK leaves `api` unset.
 *
 * An UNSAMPLED session also yields `undefined`. Faro still creates a session and
 * an id for it, but its transport drops every item whose session attribute
 * `isSampled` is not the string `'true'` (faro-web-sdk 2.8.2 session
 * instrumentation), so no telemetry exists under that id. Attaching it would point
 * a report at a session nobody can open. Only an explicit `'true'` counts; a
 * missing attribute is treated as unsampled, as the SDK treats it.
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
    const session = faro?.api?.getSession?.();
    if (session?.attributes?.isSampled !== 'true') return undefined;
    const id = session.id;
    if (typeof id !== 'string') return undefined;
    const trimmed = id.trim();
    if (!trimmed) return undefined;
    return trimmed.slice(0, FEEDBACK_SESSION_ID_MAX_LENGTH);
  } catch {
    // A partially-initialised or paused SDK is still "no session id", not a crash.
    return undefined;
  }
}
