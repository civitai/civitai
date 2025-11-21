import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { civTokenEncrypt } from '~/server/auth/civ-token';

export { civTokenEncrypt, civTokenDecrypt } from '~/server/auth/civ-token';

export default AuthedEndpoint(async function handler(req, res, user) {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  try {
    const token = civTokenEncrypt(user.id.toString());
    return res.status(200).json({ token });
  } catch (error: unknown) {
    return res.status(500).send(error);
  }
});
