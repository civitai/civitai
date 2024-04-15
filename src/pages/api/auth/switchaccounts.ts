import { serialize } from 'cookie';
import { z } from 'zod';
import { env } from '~/env/server.mjs';
import { civitaiTokenCookieName, useSecureCookies } from '~/libs/auth';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  token: z.string(),
});

const { hostname } = new URL(env.NEXTAUTH_URL);

export default PublicEndpoint(async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  const { token } = schema.parse(req.query);

  res.setHeader(
    'Set-Cookie',
    serialize(civitaiTokenCookieName, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: useSecureCookies,
      domain: hostname == 'localhost' ? hostname : '.' + hostname,
      // maxAge: 60 * 60 * 24 * 30,
    })
  );
  // res.setHeader('Set-Cookie', `${civitaiTokenCookieName}=${token}`);
  // setCookie(civitaiTokenCookieName, token, { req, res, maxAge: 60 * 60 * 24 * 30 });
  // console.log(res.getHeaders());
  res.status(200).send({ status: 'ok' });
});
