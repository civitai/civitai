import { createSpokeGuard } from '@civitai/auth';

// No redis client here, so token revocation is NOT checked — a signature-only gate. OK because the token is
// short-lived relative to ban-response needs, and mutations still re-check server-side. For real-time
// revocation, give this app a @civitai/redis client and pass `isRevoked`.
export const guard = createSpokeGuard({ require: (user) => user.isModerator === true });
