import OAuth2Server from '@node-oauth/oauth2-server';
import { oauthModel } from './model';

// Ported verbatim from the main app's src/server/oauth/server.ts. Token lifetimes mirror ./constants
// (1h access / 30d refresh); PKCE handles the security boundary for public clients so client auth is not
// required on the code/refresh grants.
export const oauthServer = new OAuth2Server({
  model: oauthModel,
  accessTokenLifetime: 60 * 60, // 1 hour
  refreshTokenLifetime: 30 * 24 * 60 * 60, // 30 days
  allowEmptyState: false,
  requireClientAuthentication: {
    authorization_code: false, // PKCE handles security for public clients
    refresh_token: false, // Public clients (SPAs) need to refresh without a secret
  },
});
