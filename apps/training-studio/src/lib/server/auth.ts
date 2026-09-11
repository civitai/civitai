import { createSpokeGuard } from '@civitai/auth';

// Training is a normal user feature, so the gate allows ANY authenticated Civitai user — the predicate
// only asserts a session resolved. No redis client here, so token revocation is NOT checked: a
// signature-only gate. OK because the token is short-lived and mutations re-check server-side. For
// real-time revocation, give this app a @civitai/redis client and pass `isRevoked`.
export const guard = createSpokeGuard({ require: (user) => !!user });
