import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { invalidateAllSessions } from '~/server/auth/session-invalidation';

// Force a global session refresh: sets the hub's SESSION.ALL revocation cutoff to now, so every token signed
// before this call is revoked (clients re-auth / refresh). The cutoff is always "now" — there's no custom
// `asOf` (mass invalidation is "revoke everything currently outstanding").
export default WebhookEndpoint(async (_req, res) => {
  await invalidateAllSessions();
  res.status(200).json({ ok: true });
});
