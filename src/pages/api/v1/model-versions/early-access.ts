import type { NextApiRequest, NextApiResponse } from 'next';
import { updateModelVersionPaidAccessSchema } from '~/server/schema/model-version.schema';
import {
  assertUserEarlyAccessLimits,
  getVersionById,
  updateModelVersionPaidAccess,
} from '~/server/services/model-version.service';
import { getModel, queueModelEarlyAccessReindex } from '~/server/services/model.service';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { Tracker } from '~/server/clickhouse/client';
import { env } from '~/env/server';
import type { SessionUser } from '~/types/session';

// Narrow cross-app write for a model version's paid-access config — the creator
// studio (SvelteKit spoke) calls this server-to-server, forwarding the shared
// .civitai.com session cookie that AuthedEndpoint validates. Body: the
// updateModelVersionPaidAccessSchema shape ({ id, paidAccess, donationGoal }); a null
// paidAccess clears the gate. Version-level rules live in the service; user-level
// limits (max days / max concurrent EA models) are enforced here.
export default AuthedEndpoint(
  async function handler(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
    const parsed = updateModelVersionPaidAccessSchema.safeParse(req.body);
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

    const { paidAccess } = input;

    // Permanent access is set only from the Creator Studio (which enforces the tier cap); require the shared token.
    if (paidAccess?.permanent && !user.isModerator && req.query.token !== env.WEBHOOK_TOKEN) {
      return res
        .status(403)
        .json({ error: 'Permanent access can only be set from the Creator Studio.' });
    }

    try {
      // Shared user-level EA caps (max days + max concurrent). Throws BAD_REQUEST → mapped to 400 below.
      await assertUserEarlyAccessLimits({
        userId: user.id,
        userMeta: user.meta,
        features: getFeatureFlags({ user, req }),
        isModerator: user.isModerator,
        timeframeDays: paidAccess?.timeframeDays,
        versionId: input.id,
      });

      const updated = await updateModelVersionPaidAccess({
        ...input,
        tracker: new Tracker(req, res),
        actorUserId: user.id,
        isModerator: user.isModerator,
      });

      await queueModelEarlyAccessReindex({ id: updated.modelId }).catch((e) => {
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
