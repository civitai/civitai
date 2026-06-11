import type { NextApiRequest, NextApiResponse } from 'next';
import { buildOAuthServerMetadata } from '~/server/oauth/discovery-metadata';

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.status(200).json({
    ...buildOAuthServerMetadata(),
    subject_types_supported: ['public'],
    // Claims returned by the userinfo endpoint. `email`/`email_verified` and
    // the profile claims are released under the UserRead scope.
    claims_supported: ['sub', 'name', 'preferred_username', 'picture', 'email', 'email_verified'],
  });
}
