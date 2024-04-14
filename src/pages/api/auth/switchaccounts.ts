import { z } from 'zod';
import { civitaiTokenCookieName } from '~/libs/auth';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  token: z.string(),
});

export default PublicEndpoint(async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  const { token } = schema.parse(req.query);

  res.setHeader('Set-Cookie', `${civitaiTokenCookieName}=${token}`);
  res.status(200).send({ status: 'ok' });
});
