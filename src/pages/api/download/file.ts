import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { getGetUrl } from '~/utils/s3-utils';

export default AuthedEndpoint(async function handler(req, res, user) {
  const { url } = req.query as { url: string };
  const result = await getGetUrl(url, { expiresIn: 7 * 24 * 60 * 60 });
  return res.redirect(result.url);
});
