import type { NextApiRequest, NextApiResponse } from 'next';
import { Tracker } from '~/server/clickhouse/client';
import { NotificationCategory } from '~/server/common/enums';
import { loginCounter, newUserCounter } from '~/server/prom/client';
import { createNotification } from '~/server/services/notification.service';
import { createUserReferral } from '~/server/services/user.service';
import { deleteEncryptedCookie } from '~/server/utils/cookie-encryption';
import { generationServiceCookie } from '~/shared/constants/generation.constants';

// The login side-effects, lifted out of next-auth's `events.signIn` so they fire identically whether the
// session is minted by next-auth (legacy) OR by the centralized hub (which redirects back through the main
// app's /api/auth/post-login handler — the hub can't run these: the `ref_*` cookies are on the civitai.com
// domain and the Tracker/notification/referral services are main-app-only). See docs/main-app-auth-cutover.md.
//
// STEP-H-REMOVAL: only the `[...nextauth]` caller goes away at step H — this module + the post-login caller stay.
export async function runLoginSideEffects({
  req,
  res,
  userId,
  isNewUser,
}: {
  req: NextApiRequest;
  res: NextApiResponse;
  userId: number;
  isNewUser: boolean;
}): Promise<void> {
  // Orchestrator service-auth cookie is reissued per-session; clear the stale one on (re)login.
  deleteEncryptedCookie({ req, res }, { name: generationServiceCookie.name });

  const source = req.cookies['ref_source'] as string;
  const landingPage = req.cookies['ref_landing_page'] as string;
  const loginRedirectReason = req.cookies['ref_login_redirect_reason'] as string;

  const tracker = new Tracker(req, res);
  if (isNewUser) {
    newUserCounter?.inc();
    await tracker.userActivity({ type: 'Registration', targetUserId: userId, source, landingPage });

    // Only source is set via the auth callback; userReferralCode requires finishing onboarding.
    if (source || landingPage || loginRedirectReason) {
      await createUserReferral({ id: userId, source, landingPage, loginRedirectReason });
    }

    await createNotification({
      type: 'join-community',
      userId,
      category: NotificationCategory.System,
      key: `join-community:${userId}`,
      details: {},
    }).catch(() => null);
  } else {
    loginCounter?.inc();
    await tracker.userActivity({ type: 'Login', targetUserId: userId, source, landingPage });
  }
}
