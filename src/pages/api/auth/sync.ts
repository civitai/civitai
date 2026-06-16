import { maybeCreateSessionSigner } from '@civitai/auth';
import { civTokenEncrypt } from '~/server/auth/civ-token';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';

// Path C (opt-in): when the hub keys are set, additionally return a signed `swapToken` the
// receiving root verifies via JWKS (no shared secret). The legacy `token` (AES civ-token)
// stays for backward compatibility until the receive side is flipped over.
const signer = maybeCreateSessionSigner();

export default AuthedEndpoint(async function handler(req, res, user) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  try {
    const userId = user.id;
    const token = civTokenEncrypt(userId.toString());
    const swapToken = signer ? await signer.mintSwapToken(userId) : undefined;
    return res.status(200).json({ token, swapToken, userId, username: user.username });
  } catch {
    // Don't leak the raw error/stack to the client.
    return res.status(500).json({ error: 'Failed to create sync token' });
  }
});
