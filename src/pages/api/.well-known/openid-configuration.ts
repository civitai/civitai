import type { NextApiRequest, NextApiResponse } from 'next';
import { env } from '~/env/server';
import { tokenScopeLabels } from '~/shared/constants/token-scope.constants';

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  const issuer = env.NEXTAUTH_URL;

  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.status(200).json({
    issuer,
    authorization_endpoint: `${issuer}/api/auth/oauth/authorize`,
    token_endpoint: `${issuer}/api/auth/oauth/token`,
    userinfo_endpoint: `${issuer}/api/auth/oauth/userinfo`,
    revocation_endpoint: `${issuer}/api/auth/oauth/revoke`,
    device_authorization_endpoint: `${issuer}/api/auth/oauth/device`,
    response_types_supported: ['code'],
    grant_types_supported: [
      'authorization_code',
      'refresh_token',
      'client_credentials',
      'urn:ietf:params:oauth:grant-type:device_code',
    ],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    scopes_supported: Object.keys(tokenScopeLabels),
    subject_types_supported: ['public'],
    // Claims returned by the userinfo endpoint. `email`/`email_verified` and
    // the profile claims are released under the UserRead scope.
    claims_supported: ['sub', 'name', 'preferred_username', 'picture', 'email', 'email_verified'],
  });
}
