// SPOKE AUTH for the moderator app (a `*.civitai.com` subdomain). It shares the hub's `.civitai.com` session
// cookie for free, so there is NO login UI and NO OAuth bridge here — it verifies the session, resolves the
// rich user, gates on `isModerator`, and redirects to the hub on miss. The framework-agnostic decision lives
// in @civitai/auth (`createSpokeGuard`); this file just binds the moderator policy. The Next adapter is
// proxy.ts. See docs/auth/spoke-integration-guide.md.
//
// No redis client here, so revocation is NOT injected — a signature-only gate. Acceptable because (a) the token
// is short-lived relative to ban-response needs, and (b) any mutating action still flows through a server
// handler that can do the authoritative check. For real-time revocation, give this app a @civitai/redis client
// and pass `isRevoked` (mirrors the main app's session-verifier.ts).
import { createSpokeGuard } from '@civitai/auth';

export const guard = createSpokeGuard({ require: (user) => user.isModerator === true });
