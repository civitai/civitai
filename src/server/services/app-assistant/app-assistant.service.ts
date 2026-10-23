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
import { getFeatureFlagsAsync, isFliptDecisive } from '~/server/services/feature-flags.service';
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

/** What the account gates read: the fields `guardedProcedure` checks. */
type GatedAccount = {
  bannedAt?: Date | null;
  onboarding?: number | null;
  muted?: boolean | null;
} & NonNullable<Parameters<typeof requiresEmailVerification>[0]>;

/** The account gates `guardedProcedure` applies, as one predicate both entry points share. */
function accountRefusal(user: GatedAccount): AppAssistantRefusal | null {
  if (user.bannedAt)
    return {
      status: 403,
      error: 'You cannot perform this action because your account has been banned',
    };
  if (!Flags.hasFlag(user.onboarding ?? 0, OnboardingSteps.Buzz))
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
  return null;
}

/** The feature gate: App Assistant is on for this user (and, when asked, its server runner). */
async function featureRefusal(
  ctx: GateContext,
  { remoteRunner = false }: { remoteRunner?: boolean } = {}
): Promise<AppAssistantRefusal | null> {
  const features = await getFeatureFlagsAsync(ctx);
  if (!canAccessAppAssistant(features))
    return { status: 403, error: 'App Assistant is not available on this account' };
  if (remoteRunner && !features.appAssistantRemoteRunner)
    return { status: 403, error: 'Replies on the server are not available on this account' };
  return null;
}

/** The `guardedProcedure` gates, then the feature gate, for a signed-in session's user. */
export async function getAppAssistantRefusal({
  user,
  req,
}: GateContext): Promise<AppAssistantRefusal | null> {
  return accountRefusal(user) ?? (await featureRefusal({ user, req }));
}

/** The gates could not be judged just now (the session hub or Flipt is unavailable): ask again. */
export interface AppAssistantGateUnavailable {
  status: 503;
  error: string;
  unavailable: true;
}

/** The flags `canAccessAppAssistant` reads. */
const APP_ASSISTANT_FLAGS = ['appBlocks', 'appAssistant'] as const;

/**
 * The same gates for a user known only by id (the server runner's mints, which have no session).
 * The gated account fields are read fresh from the primary database on every call, never from a
 * cached session, so a ban, a mute or a lost email verification stops the next mint.
 *
 * The feature gate is evaluated with no request, which matches the token route's evaluation on
 * civitai.com only while all of these hold:
 * - `appBlocks` and `appAssistant` carry no region or host rule (true today: their availability is
 *   `['mod']` and `[]`), so the request's region and host would change nothing;
 * - the session hub returns the user, which supplies Flipt's targeting attributes the database row
 *   lacks (tier, membership, early adopter, granted permissions);
 * - Flipt decides both flags (`isFliptDecisive`), rather than `hasFeature` falling back to the
 *   static rules, under which nobody passes (`appAssistant` is `availability: []`; `appBlocks`'s
 *   `['mod']` alone admits no one past it).
 * When the session hub misses or Flipt is undecided, the answer is `unavailable` (the runner asks
 * again), never a refusal: only a definite answer on that complete context refuses.
 *
 * `remoteRunner` also requires `appAssistantRemoteRunner`, decided by Flipt the same way (its static
 * rule is off for everyone), so turning the runner off stops every mint of runs already holding a
 * grant, at their next mint, not only new grants; while Flipt cannot decide it the mint answers
 * `unavailable` and the runner asks again.
 */
export async function getAppAssistantRefusalForUserId(
  userId: number,
  { remoteRunner = false }: { remoteRunner?: boolean } = {}
): Promise<AppAssistantRefusal | AppAssistantGateUnavailable | null> {
  return (await gateUserById(userId, { remoteRunner })).refusal;
}

/** The user `getAppAssistantRefusalForUserId` judged, when every gate let them through. */
async function gateUserById(
  userId: number,
  { remoteRunner }: { remoteRunner: boolean }
): Promise<
  | { refusal: AppAssistantRefusal | AppAssistantGateUnavailable; user?: undefined }
  | { refusal: null; user: SessionUser }
> {
  const row = await dbWrite.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      bannedAt: true,
      onboarding: true,
      muted: true,
      emailVerified: true,
      meta: true,
      isModerator: true,
    },
  });
  if (!row)
    return { refusal: { status: 403, error: 'App Assistant is not available on this account' } };
  const accountRefused = accountRefusal(row);
  if (accountRefused) return { refusal: accountRefused };
  const unavailable: AppAssistantGateUnavailable = {
    status: 503,
    error: 'App Assistant could not check this account just now',
    unavailable: true,
  };
  // Imported here, not at the top: the session client is built at module load, and only this path needs it.
  const { sessionClient } = await import('~/server/auth/session-client');
  const cached = await sessionClient.getSessionUserById(userId).catch(() => null);
  if (!cached) return { refusal: unavailable };
  const user = { ...cached, ...row, isModerator: !!row.isModerator } as unknown as SessionUser;
  const flags = remoteRunner
    ? [...APP_ASSISTANT_FLAGS, 'appAssistantRemoteRunner' as const]
    : [...APP_ASSISTANT_FLAGS];
  if (!(await isFliptDecisive(flags, user))) return { refusal: unavailable };
  const featureRefused = await featureRefusal({ user }, { remoteRunner });
  return featureRefused ? { refusal: featureRefused } : { refusal: null, user };
}

/** The author capability's refusal, as `appDeveloperProcedure` words it. */
export const APPS_AUTHORING_REFUSED = 'You do not have access to Apps authoring';

export type RunnerDevTunnelRefusal =
  | (AppAssistantRefusal & { code: 'refused' | 'FORBIDDEN' })
  | (AppAssistantGateUnavailable & { code: 'unavailable' });

/**
 * The user behind a run grant, for the server runner's dev-tunnel endpoints
 * (`/api/internal/app-assistant/dev-tunnel/*`), re-judged on every call:
 * - every gate the runner's token mint checks (`getAppAssistantRefusalForUserId` with
 *   `remoteRunner`: ban, onboarding, mute, email verification, `appBlocks` + `appAssistant`, and
 *   `appAssistantRemoteRunner`), answered `refused`, or `unavailable` when they cannot be judged;
 * - then the App Blocks author capability `blocks.startDevTunnel` requires through
 *   `appDeveloperProcedure`, read from the same `getFeatureFlags` evaluation (a Flipt miss falls
 *   back to its static mod-only rule, as it does there), answered `FORBIDDEN` as there.
 * The dev-tunnel flag, ownership and the start limit are the caller's to check next, through
 * `dev-tunnel-access.service.ts`, the same functions the tRPC procedure uses.
 */
export async function getRunnerDevTunnelUser(
  userId: number
): Promise<
  { refusal: RunnerDevTunnelRefusal; user?: undefined } | { refusal: null; user: SessionUser }
> {
  const gated = await gateUserById(userId, { remoteRunner: true });
  if (gated.refusal) {
    const refusal = gated.refusal;
    return {
      refusal:
        'unavailable' in refusal
          ? { ...refusal, code: 'unavailable' }
          : { ...refusal, code: 'refused' },
    };
  }
  const features = await getFeatureFlagsAsync({ user: gated.user });
  if (!features.appBlocksAuthor)
    return { refusal: { status: 403, error: APPS_AUTHORING_REFUSED, code: 'FORBIDDEN' } };
  return gated;
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
  if (!(await hasAppAssistantConsent(userId, purpose))) return null;
  const minted = await mintAppToken({
    userId,
    clientId: appAssistantClientId(userId),
    scope: scopeFor(purpose),
  });
  return { token: minted.accessToken, expiresAt: minted.expiresAt };
}

/**
 * Whether the user's App Assistant consent covers `purpose`'s scopes: written by
 * `enableAppAssistant`, gone once the user revokes it under connected apps.
 */
export async function hasAppAssistantConsent(
  userId: number,
  purpose: AppAssistantTokenPurpose = 'chat'
): Promise<boolean> {
  const scope = scopeFor(purpose);
  const consent = await dbWrite.oauthConsent.findUnique({
    where: { userId_clientId: { userId, clientId: appAssistantClientId(userId) } },
    select: { scope: true },
  });
  return !!consent && (consent.scope & scope) === scope;
}

export type AppAssistantPreview =
  | { status: 'ok'; frame: DevTunnelFrame & { iframeSrc: string } }
  | { status: 'preparing' }
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
  if (frame.dnsPending) return { status: 'preparing' };
  if (!frame.iframeSrc) return { status: 'no-tunnel' };
  return { status: 'ok', frame: { ...frame, iframeSrc: frame.iframeSrc } };
}
