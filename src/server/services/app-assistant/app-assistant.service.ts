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
import {
  APP_ASSISTANT_DAILY_BUZZ_CAP,
  APP_ASSISTANT_SCOPES,
} from '~/shared/constants/app-assistant.constants';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { canAccessAppAssistant } from '~/shared/utils/app-blocks-access';
import { Flags } from '~/shared/utils/flags';
import type { SessionUser } from '~/types/session';

/**
 * One OAuth client per user rather than one shared row: an `OauthClient` belongs to the user in its
 * `userId`, who may edit or delete it through the OAuth-apps settings, so a shared row would be one
 * user's to break for everyone. Not `firstparty-`: the auth hub reserves that prefix for its own
 * trusted clients.
 */
export const APP_ASSISTANT_CLIENT_PREFIX = 'appassist-';

export function appAssistantClientId(userId: number): string {
  return `${APP_ASSISTANT_CLIENT_PREFIX}${userId}`;
}

/**
 * Who a token is for. The chat spends Buzz; the hosted sandbox service only needs to know who the
 * user is, so it gets `UserRead` alone.
 */
export type AppAssistantTokenPurpose = 'chat' | 'sandbox';

function scopeFor(purpose: AppAssistantTokenPurpose): number {
  return purpose === 'chat' ? oauthScopeBitsFor([...APP_ASSISTANT_SCOPES]) : TokenScope.UserRead;
}

export interface AppAssistantRefusal {
  status: 403;
  error: string;
}

type GateContext = { user: SessionUser; req?: NextApiRequest | IncomingMessage };

/** The `guardedProcedure` gates, then the feature gate. */
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
 * Turns App Assistant on for the user: their own client, and consent for its scopes with a daily
 * Buzz cap. Only an explicit request from the user may call this, never a token refresh, so revoking
 * the app under connected apps stays revoked. A consent that already covers the scopes is left alone,
 * so a limit the user changed survives.
 */
export async function enableAppAssistant(userId: number): Promise<void> {
  const clientId = appAssistantClientId(userId);
  const scope = scopeFor('chat');

  const client = await dbWrite.oauthClient.findUnique({
    where: { id: clientId },
    select: { allowedScopes: true },
  });
  if (client?.allowedScopes !== scope)
    await dbWrite.oauthClient.upsert({
      where: { id: clientId },
      create: {
        id: clientId,
        secret: null,
        name: 'App Assistant',
        description:
          'The Civitai App Assistant, building apps in your sandbox. Only you can use it.',
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
  if (!existing || (existing.scope & scope) !== scope)
    await writeOauthConsent({
      userId,
      clientId,
      scope: (existing?.scope ?? 0) | scope,
      buzzLimit: existing
        ? (existing.buzzLimit as BuzzLimit | null)
        : simpleBuzzLimitToBudgets({ limit: APP_ASSISTANT_DAILY_BUZZ_CAP, period: 'day' }),
    });
}

/**
 * Mints an access token for `purpose` against the consent `enableAppAssistant` wrote, or returns
 * `null` when there is none covering the scopes (never turned on, or revoked since).
 */
export async function mintAppAssistantToken(
  userId: number,
  purpose: AppAssistantTokenPurpose
): Promise<AppAssistantToken | null> {
  const clientId = appAssistantClientId(userId);
  const scope = scopeFor(purpose);
  const consent = await dbWrite.oauthConsent.findUnique({
    where: { userId_clientId: { userId, clientId } },
    select: { scope: true },
  });
  if (!consent || (consent.scope & scope) !== scope) return null;

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
