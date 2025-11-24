import { civTokenEncrypt } from '~/server/auth/civ-token';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';

export default AuthedEndpoint(async function handler(req, res, user) {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  try {
    const userId = user.id;
    const token = civTokenEncrypt(userId.toString());
    return res.status(200).json({ token, userId, username: user.username });
  } catch (error: unknown) {
    return res.status(500).send(error);
  }
});
