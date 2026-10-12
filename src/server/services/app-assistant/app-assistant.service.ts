import type { IncomingMessage } from 'http';
import type { NextApiRequest } from 'next';
import { mintAppToken } from '@civitai/auth';
import { requiresEmailVerification } from '~/server/common/email-verification-gate';
import { OnboardingSteps } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import type { BuzzLimit } from '~/server/schema/api-key.schema';
import { simpleBuzzLimitToBudgets } from '~/server/schema/api-key.schema';
import { isAppBlocksDevTunnelEnabled } from '~/server/services/app-blocks-flag';
import { oauthScopeBitsFor } from '~/server/services/blocks/block-oauth-scope';
import type { DevTunnelFrame } from '~/server/services/blocks/dev-tunnel-frame.service';
import { resolveDevTunnelFrame } from '~/server/services/blocks/dev-tunnel-frame.service';
import { writeOauthConsent } from '~/server/services/blocks/oauth-consent-sync.service';
import { getFeatureFlagsAsync } from '~/server/services/feature-flags.service';
import { canAccessAppAssistant } from '~/shared/utils/app-blocks-access';
import { Flags } from '~/shared/utils/flags';
import type { SessionUser } from '~/types/session';

/**
 * One OAuth client per user rather than one shared row: an `OauthClient` belongs to the user in its
 * `userId`, who may edit or delete it through the OAuth-apps settings, so a shared first-party row
 * would be one user's to break for everyone.
 */
export const APP_ASSISTANT_CLIENT_PREFIX = 'firstparty-app-assistant-';

export function appAssistantClientId(userId: number): string {
  return `${APP_ASSISTANT_CLIENT_PREFIX}${userId}`;
}

/** `<civitai-chat>` refuses to start without `ai:write:budgeted`; every OAuth token also carries `UserRead`. */
export const APP_ASSISTANT_SCOPES = ['ai:write:budgeted'] as const;

/** The daily Buzz limit a NEW consent gets; the user can change it under their connected apps. */
export const APP_ASSISTANT_DAILY_BUZZ_CAP = 5000;

export interface AppAssistantRefusal {
  status: 403;
  error: string;
}

type GateContext = { user: SessionUser; req?: NextApiRequest | IncomingMessage };

/** `guardedProcedure`'s gates (banned → onboarded → muted → email-verified), then the feature gate. */
export async function getAppAssistantRefusal({
  user,
  req,
}: GateContext): Promise<AppAssistantRefusal | null> {
  if (user.bannedAt)
    return {
      status: 403,
      error: 'You cannot perform this action because your account has been banned',
    };
  if (!Flags.hasFlag(user.onboarding, OnboardingSteps.Buzz))
    return {
      status: 403,
      error: 'You must complete the onboarding process before performing this action',
    };
  if (user.muted)
    return {
      status: 403,
      error: 'You cannot perform this action because your account has been restricted',
    };
  if (requiresEmailVerification(user))
    return { status: 403, error: 'Verify your email address to do this' };
  const features = await getFeatureFlagsAsync({ user, req });
  if (!canAccessAppAssistant(features))
    return { status: 403, error: 'App Assistant is not available on this account' };
  return null;
}

export interface AppAssistantToken {
  token: string;
  expiresAt: string;
}

/**
 * Mints an OAuth access token for the caller's own App Assistant client. The user is the only
 * person who can reach their client, so consent is written for them here rather than collected
 * through the dialog. An existing consent that already covers the scopes is left alone, so a Buzz
 * limit the user changed survives the next mint.
 */
export async function mintAppAssistantToken(userId: number): Promise<AppAssistantToken> {
  const clientId = appAssistantClientId(userId);
  const scope = oauthScopeBitsFor([...APP_ASSISTANT_SCOPES]);

  await dbWrite.oauthClient.upsert({
    where: { id: clientId },
    create: {
      id: clientId,
      secret: null,
      name: 'App Assistant',
      description: 'The Civitai App Assistant, building apps in your sandbox. Only you can use it.',
      redirectUris: [],
      allowedOrigins: [],
      isConfidential: false,
      grants: [],
      allowedScopes: scope,
      userId,
    },
    update: { allowedScopes: scope },
    select: { id: true },
  });

  const existing = await dbWrite.oauthConsent.findUnique({
    where: { userId_clientId: { userId, clientId } },
    select: { scope: true, buzzLimit: true },
  });
  if (!existing || (existing.scope & scope) !== scope) {
    await writeOauthConsent({
      userId,
      clientId,
      scope: (existing?.scope ?? 0) | scope,
      buzzLimit: existing
        ? (existing.buzzLimit as BuzzLimit | null)
        : simpleBuzzLimitToBudgets({ limit: APP_ASSISTANT_DAILY_BUZZ_CAP, period: 'day' }),
    });
  }

  const minted = await mintAppToken({ userId, clientId, scope });
  return { token: minted.accessToken, expiresAt: minted.expiresAt };
}

export type AppAssistantPreview =
  | { status: 'ok'; frame: DevTunnelFrame & { iframeSrc: string } }
  | { status: 'no-tunnel' }
  | { status: 'not-found' }
  | { status: 'forbidden'; error: string };

/**
 * The preview pane's frame for `blockId`: the caller's own app over its live dev tunnel. Needs the
 * same author capability and dev-tunnel flag that `blocks.startDevTunnel` checks.
 */
export async function getAppAssistantPreview({
  user,
  req,
  blockId,
}: GateContext & { blockId: string }): Promise<AppAssistantPreview> {
  const features = await getFeatureFlagsAsync({ user, req });
  if (!features.appBlocksAuthor || !(await isAppBlocksDevTunnelEnabled({ user })))
    return { status: 'forbidden', error: 'Live preview is not available on this account' };
  const frame = await resolveDevTunnelFrame(user, blockId);
  if (!frame) return { status: 'not-found' };
  if (!frame.iframeSrc) return { status: 'no-tunnel' };
  return { status: 'ok', frame: { ...frame, iframeSrc: frame.iframeSrc } };
}
