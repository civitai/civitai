import type { NextApiRequest, NextApiResponse } from 'next';
import { upsertCreatorAnnouncementSchema } from '~/server/schema/announcement.schema';
import { getAnnouncementAllowance } from '~/server/services/announcement-allowance.service';
import { throwAuthorizationError } from '~/server/utils/errorHandling';
import {
  deleteCreatorAnnouncement,
  upsertCreatorAnnouncement,
} from '~/server/services/creator-announcement.service';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { AuthedEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import type { SessionUser } from '~/types/session';
import { Flags } from '~/shared/utils/flags';
import { OnboardingSteps } from '~/server/common/enums';

// Creator announcements from a spoke (the Creator Studio composer), which has no tRPC
// client — same server-to-server shape as /api/v1/creator-program/join, forwarding the
// shared .civitai.com session cookie that AuthedEndpoint validates.
//
// 🔴 These call the same creator service the onsite procedures do. They do NOT reimplement
// the boundary: the request body is parsed by the creator schema, which has no
// `metadata.type` field, so no spoke request can reach the sitewide surfaces however it is
// shaped. Adding a field here that the schema does not have is how that stops being true.

// The composer sends dates as JSON strings; the service takes Dates.
function reviveDates(body: Record<string, unknown>) {
  const out = { ...body };
  for (const key of ['startsAt', 'endsAt'] as const) {
    const value = out[key];
    if (typeof value === 'string') out[key] = new Date(value);
  }
  return out;
}

/**
 * 🔴 AuthedEndpoint is session-presence only, a rung below the tRPC twin
 * (`guardedProcedure` = protected + onboarded + not-muted). Without these three checks a
 * creator refused onsite — muted, un-onboarded, or simply outside the flag — is accepted
 * through the spoke and their announcement fans out to every follower. The spoke must not
 * be the cheaper door.
 */
function assertMayUseSpoke(user: SessionUser, req: NextApiRequest) {
  if (!getFeatureFlags({ user, req }).creatorAnnouncements)
    throw throwAuthorizationError('Announcements are not available for this account');
  if (user.muted) throw throwAuthorizationError('Your account is muted');
  if (!Flags.hasFlag(user.onboarding, OnboardingSteps.Buzz))
    throw throwAuthorizationError('You must complete onboarding before posting an announcement');
}

export default AuthedEndpoint(
  async function handler(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
    try {
      assertMayUseSpoke(user, req);

      if (req.method === 'GET') {
        return res.status(200).json(await getAnnouncementAllowance(user.id));
      }

      const body = (req.body ?? {}) as Record<string, unknown>;

      if (req.method === 'DELETE') {
        const id = Number(body.id ?? req.query.id);
        if (!Number.isInteger(id))
          return res.status(400).json({ error: 'A numeric id is required' });
        return res.status(200).json(
          await deleteCreatorAnnouncement({
            id,
            userId: user.id,
            isModerator: user.isModerator ?? false,
          })
        );
      }

      const parsed = upsertCreatorAnnouncementSchema.safeParse(reviveDates(body));
      if (!parsed.success)
        return res
          .status(400)
          .json({ error: 'Invalid announcement', details: parsed.error.issues });

      return res.status(200).json(
        await upsertCreatorAnnouncement({
          ...parsed.data,
          userId: user.id,
          isModerator: user.isModerator ?? false,
        })
      );
    } catch (error) {
      // Never serialize the error itself: a Prisma error's enumerable own props carry the
      // table and column, and a pg 23505 carries the offending row value. The audience
      // here is a cross-origin caller.
      return handleEndpointError(res, error);
    }
  },
  ['GET', 'POST', 'DELETE']
);
