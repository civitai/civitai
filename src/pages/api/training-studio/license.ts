import * as z from 'zod';
import {
  acceptGenerationLicense,
  pendingTrainingLicenseEcosystems,
} from '~/server/services/generation-license.service';
import { AuthedEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { allowTrainingStudio } from '~/server/utils/training-studio-access';
import { getTrainingLicenseTerms } from '~/shared/constants/generation-license.constants';

const acceptSchema = z.object({ ecosystem: z.string().min(1).max(100) }).strict();

/**
 * The base model licences behind the Training Studio's training runs. GET answers
 * { pending: string[] }, the AI Toolkit ecosystems whose licence this user has yet to accept;
 * POST { ecosystem } records the acceptance of that ecosystem's licence, the same one the generator asks for.
 */
export default AuthedEndpoint(
  async (req, res, user) => {
    if (!(await allowTrainingStudio(req, res, user, { pageFlag: false }))) return;
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.method === 'GET')
        return res.json({ pending: await pendingTrainingLicenseEcosystems(user.id) });

      const input = acceptSchema.safeParse(req.body);
      const terms = input.success ? getTrainingLicenseTerms(input.data.ecosystem) : undefined;
      if (!terms) return res.status(400).json({ error: 'No licence to accept for this model.' });
      await acceptGenerationLicense({ userId: user.id, ecosystem: terms.ecosystems[0]! });
      return res.json({ ok: true });
    } catch (e) {
      return handleEndpointError(res, e);
    }
  },
  ['GET', 'POST']
);
