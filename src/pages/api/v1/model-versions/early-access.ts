import type { NextApiRequest, NextApiResponse } from 'next';
import { updateEarlyAccessConfigSchema } from '~/server/schema/model-version.schema';
import {
  getUserEarlyAccessModelVersions,
  getVersionById,
  updateModelVersionEarlyAccessConfig,
} from '~/server/services/model-version.service';
import { getModel, updateModelEarlyAccessDeadline } from '~/server/services/model.service';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { getMaxEarlyAccessDays, getMaxEarlyAccessModels } from '~/server/utils/early-access-helpers';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { env } from '~/env/server';
import type { SessionUser } from '~/types/session';

// Narrow cross-app write for a model version's early-access config — the creator
// studio (SvelteKit spoke) calls this server-to-server, forwarding the shared
// .civitai.com session cookie that AuthedEndpoint validates. Body: the
// updateEarlyAccessConfigSchema shape ({ id, earlyAccessConfig }); a null config
// clears early access. Version-level rules + config merge live in the service;
// user-level limits (max days / max concurrent EA models) are enforced here.
export default AuthedEndpoint(
  async function handler(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
    const parsed = updateEarlyAccessConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid request body', details: parsed.error.flatten() });
    }
    const input = parsed.data;

    const version = await getVersionById({ id: input.id, select: { modelId: true } });
    if (!version) return res.status(404).json({ error: 'Model version not found' });

    if (!user.isModerator) {
      const model = await getModel({ id: version.modelId, select: { userId: true } });
      if (model?.userId !== user.id) {
        return res.status(403).json({ error: 'You do not own this model version' });
      }
    }

    const { earlyAccessConfig } = input;

    // Permanent access is set only from the Creator Studio (which enforces the tier cap); require the shared token.
    if (earlyAccessConfig?.permanent && !user.isModerator && req.query.token !== env.WEBHOOK_TOKEN) {
      return res
        .status(403)
        .json({ error: 'Permanent access can only be set from the Creator Studio.' });
    }

    if (earlyAccessConfig?.timeframe && !user.isModerator) {
      const features = getFeatureFlags({ user, req });
      const maxDays = getMaxEarlyAccessDays({ userMeta: user.meta, features });
      if (earlyAccessConfig.timeframe > maxDays) {
        return res.status(400).json({ error: 'Early access days exceeds user limit' });
      }

      const activeEarlyAccess = await getUserEarlyAccessModelVersions({ userId: user.id });
      if (
        activeEarlyAccess.length >= getMaxEarlyAccessModels({ userMeta: user.meta, features }) &&
        !activeEarlyAccess.some((v) => v.id === input.id)
      ) {
        return res.status(400).json({
          error: 'You have exceeded the maximum number of early access models you can have.',
        });
      }
    }

    try {
      const updated = await updateModelVersionEarlyAccessConfig(input);

      await updateModelEarlyAccessDeadline({ id: updated.modelId }).catch((e) => {
        console.error('Unable to update model early access deadline', e);
      });

      return res
        .status(200)
        .json({ success: true, modelVersionId: updated.id, modelId: updated.modelId });
    } catch (error) {
      const err = error as { code?: string; message?: string };
      const status = err?.code === 'BAD_REQUEST' ? 400 : 500;
      return res.status(status).json({ error: err?.message ?? 'Failed to update early access' });
    }
  },
  ['POST']
);
