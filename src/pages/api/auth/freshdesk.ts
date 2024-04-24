import { NextApiRequest, NextApiResponse } from 'next';
import { Session } from 'next-auth';
import { z } from 'zod';
import { env } from '~/env/server.mjs';
import { createFreshdeskToken } from '~/server/integrations/freshdesk';
import { MixedAuthEndpoint } from '~/server/utils/endpoint-helpers';
import { getLoginLink } from '~/utils/login-helpers';

const schema = z.object({
  nonce: z.string(),
  state: z.string(),
});
export default MixedAuthEndpoint(async function (
  req: NextApiRequest,
  res: NextApiResponse,
  user: Session['user'] | undefined
) {
  // Redirect if not authenticated
  if (!user?.username || !user?.email) return res.redirect(getLoginLink({ returnUrl: req.url }));
  if (!env.FRESHDESK_JWT_SECRET) return res.status(500).send('FRESHDESK_JWT_SECRET not set');
  if (!env.FRESHDESK_JWT_URL) return res.status(500).send('FRESHDESK_JWT_URL not set');

  // Parse query
  const { nonce, state } = schema.parse(req.query);

  // Prepare JWT
  const id_token = (await createFreshdeskToken(user, nonce)) as string;

  // Redirect to Freshdesk
  return res.redirect(`${env.FRESHDESK_JWT_URL}?` + new URLSearchParams({ id_token, state }));
});
