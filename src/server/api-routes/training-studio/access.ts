import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { allowTrainingStudio } from '~/server/utils/training-studio-access';

/**
 * Whether this user may use the Training Studio embedded in this app: 200 { ok: true }, else the
 * refusal `allowTrainingStudio` answers. The Studio's server asks this, with the user's session,
 * for a request the embed forwarded on behalf of a user outside its own closed beta.
 */
export default AuthedEndpoint(async (req, res, user) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!(await allowTrainingStudio(req, res, user))) return;
  return res.json({ ok: true });
});
