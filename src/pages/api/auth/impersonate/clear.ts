import { clearOgModCookie } from '~/server/auth/og-mod-cookie';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

export default PublicEndpoint(
  async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    clearOgModCookie(res);
    return res.status(204).end();
  },
  ['POST']
);
