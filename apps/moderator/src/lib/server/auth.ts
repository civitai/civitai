import { createSpokeGuard } from '@civitai/auth';

// SPOKE AUTH for the moderator app (a `*.civitai.com` subdomain). It shares the hub's `.civitai.com` session
// cookie for free, so there is NO login UI and NO OAuth bridge here — it verifies the session, resolves the
// rich user, gates on `isModerator`, and lets the framework adapter (hooks.server.ts) act on the result. The
// framework-agnostic decision lives in @civitai/auth (`createSpokeGuard`); this file just binds the policy.
//
// No redis client here, so revocation is NOT injected — a signature-only gate. Acceptable because the token is
// short-lived relative to ban-response needs, and any mutating action still flows through a server handler that
// can re-check. For real-time revocation, give this app a @civitai/redis client and pass `isRevoked`.
export const guard = createSpokeGuard({ require: (user) => user.isModerator === true });
