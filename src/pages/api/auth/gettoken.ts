import { civitaiTokenCookieName } from '~/libs/auth';
import { MixedAuthEndpoint } from '~/server/utils/endpoint-helpers';

export default MixedAuthEndpoint(async function handler(req, res) {
  // export default async function fetchToken(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  try {
    const token = req.cookies[civitaiTokenCookieName] ?? null;

    // const tokenData = await getToken({
    //   req,
    //   secret: process.env.NEXTAUTH_SECRET,
    //   cookieName: civitaiTokenCookieName,
    //   raw: true
    // });

    const response = { token };
    res.status(200).send(response);
  } catch (error: unknown) {
    res.status(500).send(error);
  }
});
