import type { NextApiRequest, NextApiResponse } from 'next';
import NextAuth from 'next-auth';
import { callbackCookieName, civitaiTokenCookieName } from '~/libs/auth';
import { Tracker } from '~/server/clickhouse/client';
import { NotificationCategory } from '~/server/common/enums';
import { loginCounter, newUserCounter } from '~/server/prom/client';
import { createNotification } from '~/server/services/notification.service';
import { createUserReferral } from '~/server/services/user.service';
import { deleteEncryptedCookie } from '~/server/utils/cookie-encryption';
import { invalidateToken } from '~/server/auth/token-tracking';
import { generationServiceCookie } from '~/shared/constants/generation.constants';
import { createLogger } from '~/utils/logging';
import { createAuthOptions } from '~/server/auth/next-auth-options';

const log = createLogger('nextauth', 'blue');

export default async function auth(req: NextApiRequest, res: NextApiResponse) {
  // console.log(new Date().toISOString() + ' ::', 'nextauth', req.url);
  const customAuthOptions = createAuthOptions(req);
  // Yes, this is intended. Without this, you can't log in to a user
  // while already logged in as another
  if (req.url?.startsWith('/api/auth/callback/')) {
    const callbackUrl = req.cookies[callbackCookieName];
    if (!callbackUrl?.includes('connect=true')) delete req.cookies[civitaiTokenCookieName];
  }

  customAuthOptions.events ??= {};

  customAuthOptions.events.signOut = async ({ token }) => {
    // Invalidate the token
    await invalidateToken(token);
    // Delete encrypted cookies
    deleteEncryptedCookie({ req, res }, { name: generationServiceCookie.name });
  };

  customAuthOptions.events.signIn = async (context) => {
    deleteEncryptedCookie({ req, res }, { name: generationServiceCookie.name });

    const source = req.cookies['ref_source'] as string;
    const landingPage = req.cookies['ref_landing_page'] as string;
    const loginRedirectReason = req.cookies['ref_login_redirect_reason'] as string;

    const tracker = new Tracker(req, res);
    if (context.isNewUser) {
      newUserCounter?.inc();
      await tracker.userActivity({
        type: 'Registration',
        targetUserId: context.user.id,
        source,
        landingPage,
      });

      if (source || landingPage || loginRedirectReason) {
        // Only source will be set via the auth callback.
        // For userReferralCode, the user must finish onboarding.
        await createUserReferral({
          id: context.user.id,
          source,
          landingPage,
          loginRedirectReason,
        });
      }

      // does this work for email login? it should
      await createNotification({
        type: 'join-community',
        userId: context.user.id,
        category: NotificationCategory.System,
        key: `join-community:${context.user.id}`,
        details: {},
      }).catch();
    } else {
      loginCounter?.inc();
      await tracker.userActivity({
        type: 'Login',
        targetUserId: context.user.id,
        source,
        landingPage,
      });
    }
  };

  return await NextAuth(req, res, customAuthOptions);
}
