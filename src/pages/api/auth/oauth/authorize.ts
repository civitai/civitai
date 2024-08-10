import { Request, Response } from '@node-oauth/oauth2-server';
import { oauth } from '~/server/oauth/server';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';

export default AuthedEndpoint(
  async function handler(req, res, user) {
    try {
      const result = await oauth.authorize(new Request(req), new Response(res), {
        authenticateHandler: {
          handle: () => user,
        },
      });
      const { state, nonce } = req.query;
      const location = new URL(result.redirectUri);
      location.searchParams.set('code', result.authorizationCode);
      if (state) location.searchParams.set('state', state.toString());
      if (nonce) location.searchParams.set('nonce', nonce.toString());
      return res.status(200).json({
        location: location.toString(),
      });
    } catch (error) {
      const err = error as Error;
      console.log(err);
      return res.status(500).json({ error: err.message });
    }
  },
  ['POST']
);
