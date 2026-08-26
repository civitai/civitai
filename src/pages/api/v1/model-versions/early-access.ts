import type { NextApiRequest, NextApiResponse } from 'next';
import { paidAccessBlockedFor } from '@civitai/buzz';
import { updateModelVersionPaidAccessSchema } from '~/server/schema/model-version.schema';
import {
  assertUserEarlyAccessLimits,
  getVersionById,
  updateModelVersionPaidAccess,
} from '~/server/services/model-version.service';
import { getModel, queueModelEarlyAccessReindex } from '~/server/services/model.service';
import { assertMonetizationWrite } from '~/server/services/paid-access.service';
import { recordPricingSlot, releasePricingSlot } from '~/server/services/pricing-slot.service';
import { getCapTier } from '~/server/services/subscriptions.service';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { Tracker } from '~/server/clickhouse/client';
import { env } from '~/env/server';
import type { SessionUser } from '~/types/session';

// Narrow cross-app write for a model version's paid-access config — the creator
// studio (SvelteKit spoke) calls this server-to-server, forwarding the shared
// .civitai.com session cookie that AuthedEndpoint validates. Body: the
// updateModelVersionPaidAccessSchema shape ({ id, paidAccess, donationGoal, rightsAffirmed });
// a null paidAccess clears the gate, and rightsAffirmed is the creator's confirmation that they
// may monetize (required by the service the first time a version charges). Version-level rules
// live in the service; user-level limits (max days / max concurrent EA models) are enforced here.
export default AuthedEndpoint(
  async function handler(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
    const parsed = updateModelVersionPaidAccessSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid request body', details: parsed.error.flatten() });
    }
    const input = parsed.data;

    const version = await getVersionById({
      id: input.id,
      select: { modelId: true, baseModel: true, licensingFee: true },
    });
    if (!version) return res.status(404).json({ error: 'Model version not found' });

    const model = await getModel({
      id: version.modelId,
      select: { userId: true, poi: true, availability: true },
    });

    if (!user.isModerator && model?.userId !== user.id) {
      return res.status(403).json({ error: 'You do not own this model version' });
    }

    const { paidAccess } = input;

    // Refused rather than stripped: this caller is explicitly asking to CREATE a gate, so silently
    // writing nothing would report success for something that did not happen. Moderators included —
    // the rule is about the model, not about who is asking. The tRPC upsert strips instead, because
    // there an unrelated edit must not be blocked by a charge the creator can no longer see.
    if (paidAccess && model && paidAccessBlockedFor(model)) {
      return res.status(400).json({
        error: model.poi
          ? "A model depicting a real person can't have paid access."
          : "A private model can't have paid access.",
      });
    }

    // Permanent access is reachable only from the Creator Studio — require the shared token. The
    // monetization rules themselves are enforced below, not by whoever is calling.
    if (paidAccess?.permanent && !user.isModerator && req.query.token !== env.WEBHOOK_TOKEN) {
      return res
        .status(403)
        .json({ error: 'Permanent access can only be set from the Creator Studio.' });
    }

    try {
      // Eligibility floor + monthly allowance. This endpoint is reachable directly with a session
      // cookie, so without this a creator could POST a gate and bypass the rules the tRPC handler and
      // the Creator Studio action both apply. Tier is read fresh so a change takes effect immediately.
      // The OWNER, not the actor: a moderator may reach this endpoint for anyone's version, and the
      // floor and the allowance are about whoever sells the model.
      const ownerId = model?.userId ?? user.id;
      const actingOnOwnModel = ownerId === user.id;
      const { spendsSlot, releasesSlot } = await assertMonetizationWrite({
        ownerId,
        isModerator: user.isModerator,
        versionId: input.id,
        paidAccess,
        // Without this a version that already charges a fee reads as newly priced when a gate is added
        // — which, with no backfill, is every fee-bearing version there is.
        storedLicensingFee: version.licensingFee != null ? Number(version.licensingFee) : 0,
        tier: () => getCapTier(ownerId),
        userMeta: actingOnOwnModel ? user.meta : undefined,
        baseModel: version.baseModel,
      });

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

      if (spendsSlot)
        await recordPricingSlot({ entityType: 'ModelVersion', entityId: updated.id, ownerId });
      else if (releasesSlot)
        await releasePricingSlot({ entityType: 'ModelVersion', entityId: updated.id, ownerId });

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
