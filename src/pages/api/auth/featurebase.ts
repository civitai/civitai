import { NextApiRequest, NextApiResponse } from 'next';
import { Session } from 'next-auth';
import { z } from 'zod';
import { env } from '~/env/server.mjs';
import { createFeaturebaseToken } from '~/server/integrations/featurebase';
import { MixedAuthEndpoint } from '~/server/utils/endpoint-helpers';
import { getLoginLink } from '~/utils/login-helpers';

const schema = z.object({
  return_to: z.string().url(),
});
export default MixedAuthEndpoint(async function (
  req: NextApiRequest,
  res: NextApiResponse,
  user: Session['user'] | undefined
) {
  // Redirect if not authenticated
  if (!user?.username || !user?.email) return res.redirect(getLoginLink({ returnUrl: req.url }));
  if (!env.FEATUREBASE_JWT_SECRET) return res.status(500).send('FEATUREBASE_JWT_SECRET not set');
  if (!env.FEATUREBASE_URL) return res.status(500).send('FEATUREBASE_URL not set');

  // Prepare JWT
  const jwt = createFeaturebaseToken(user as { username: string; email: string }) as string;

  // Redirect to Featurebase
  const { return_to } = schema.parse(req.query);
  return res.redirect(
    `${env.FEATUREBASE_URL}/api/v1/auth/access/jwt?` + new URLSearchParams({ jwt, return_to })
  );
});
