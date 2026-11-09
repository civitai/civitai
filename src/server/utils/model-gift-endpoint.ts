import type { NextApiRequest, NextApiResponse } from 'next';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { getRequestCredential } from '~/server/auth/request-credential';
import { EMAIL_VERIFICATION_REQUIRED_MESSAGE } from '~/server/common/content-restriction';
import { requiresEmailVerification } from '~/server/common/email-verification-gate';
import { OnboardingSteps } from '~/server/common/enums';
import { GIFT_CLAIMS_PAGE_MAX } from '~/server/services/model-version-gift.constants';
import { mutedAccountRefusal } from '~/server/services/account-restriction.service';
import { isAccountMuted } from '~/server/services/account-standing.service';
import { getFeatureFlagsAsync } from '~/server/services/feature-flags.service';
import { matchedScope } from '~/server/services/oauth/enforce-token-scope';
import { AuthedEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { Flags } from '~/shared/utils/flags';
import type { SessionUser } from '~/types/session';

export function GiftEndpoint(
  handler: (req: NextApiRequest, res: NextApiResponse, user: SessionUser) => Promise<unknown>,
  allowedMethods: string[]
) {
  return AuthedEndpoint(async (req, res, user) => {
    const { tokenScope } = getRequestCredential(req);
    if (
      tokenScope !== TokenScope.Full &&
      matchedScope(tokenScope, [TokenScope.ModelsWrite]) === undefined
    )
      return res.status(403).json({ error: 'This token lacks the ModelsWrite scope.' });

    if (!(await getFeatureFlagsAsync({ user, req })).modelGiftLinks)
      return res.status(404).json({ error: 'Not Found' });

    res.setHeader('Cache-Control', 'private, no-store');
    try {
      if (req.method !== 'GET') await assertGuardedUser(user);
      await handler(req, res, user);
    } catch (error) {
      return handleEndpointError(res, error);
    }
  }, allowedMethods);
}

/** The paging query of the claimer lists. */
export const giftClaimsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(GIFT_CLAIMS_PAGE_MAX).default(GIFT_CLAIMS_PAGE_MAX),
  cursor: z.string().min(1).max(200).optional(),
});

export function parseVersionId(req: NextApiRequest) {
  const id = Number(req.query.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** The `guardedProcedure` gates (onboarded, not muted, email verified) the tRPC gift writes run behind. */
async function assertGuardedUser(user: SessionUser) {
  if (!Flags.hasFlag(user.onboarding, OnboardingSteps.Buzz))
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You must complete the onboarding process before performing this action',
    });
  if (user.muted || (await isAccountMuted(user.id, !!user.muted)))
    throw await mutedAccountRefusal(user.id, user);
  if (requiresEmailVerification(user))
    throw new TRPCError({ code: 'FORBIDDEN', message: EMAIL_VERIFICATION_REQUIRED_MESSAGE });
}
