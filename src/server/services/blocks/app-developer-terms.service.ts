import { TRPCError } from '@trpc/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { ACTIVE_RATE_CARD } from '~/server/services/blocks/rate-card';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { BLOCK_GOOD_APP_OWNER_SHARE } from '~/shared/constants/block-goods.constants';
import {
  APP_DEVELOPER_TERMS_VERSION,
  appOwnerTermsRefusalMessage,
  DEVELOPER_RATE_CARD_SHOWN_ROWS,
  AppDeveloperTermsNotAcceptedError,
  appDeveloperTermsRefusalMessage,
} from '~/shared/constants/app-developer-terms.constants';
import type { DeveloperRateCardRow } from '~/shared/constants/app-developer-terms.constants';

export { AppDeveloperTermsNotAcceptedError };

export async function hasAcceptedAppDeveloperTerms(userId: number): Promise<boolean> {
  // dbWrite: a developer who ticks the box and submits in the same breath must not be refused by
  // replica lag.
  const row = await dbWrite.appDeveloperTermsAcceptance.findUnique({
    where: { userId_version: { userId, version: APP_DEVELOPER_TERMS_VERSION } },
    select: { userId: true },
  });
  return !!row;
}

export async function getAppDeveloperTermsStatus(userId: number) {
  const row = await dbRead.appDeveloperTermsAcceptance.findUnique({
    where: { userId_version: { userId, version: APP_DEVELOPER_TERMS_VERSION } },
    select: { acceptedAt: true },
  });
  return { version: APP_DEVELOPER_TERMS_VERSION, acceptedAt: row?.acceptedAt ?? null };
}

/** Idempotent: re-accepting the same version keeps the first accepted-at. */
export async function acceptAppDeveloperTerms({
  userId,
  version,
}: {
  userId: number;
  version: string;
}) {
  const row = await dbWrite.appDeveloperTermsAcceptance.upsert({
    where: { userId_version: { userId, version } },
    create: { userId, version },
    update: {},
    select: { acceptedAt: true },
  });
  return { version, acceptedAt: row.acceptedAt };
}

export async function assertAcceptedAppDeveloperTerms(userId: number): Promise<void> {
  if (!(await hasAcceptedAppDeveloperTerms(userId)))
    throw new AppDeveloperTermsNotAcceptedError(appDeveloperTermsRefusalMessage(getBaseUrl()));
}

/** For tRPC callers: a FORBIDDEN the client shows as is, instead of a masked 500. */
export async function assertAcceptedAppDeveloperTermsTrpc(userId: number): Promise<void> {
  if (!(await hasAcceptedAppDeveloperTerms(userId))) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: appDeveloperTermsRefusalMessage(getBaseUrl()),
    });
  }
}

/**
 * The developer-facing rate card, read from the same constants the payouts use so what is shown
 * is what is paid. Which rows are shown is a launch decision, kept apart from the rate math.
 */
export function getDeveloperRateCard() {
  const share = ACTIVE_RATE_CARD.publisherSharePctByScope;
  const sharePct: Record<DeveloperRateCardRow, number> = {
    goods: Math.round(BLOCK_GOOD_APP_OWNER_SHARE * 100),
    publisher_all_my_models: share.publisher_all_my_models,
    viewer_personal: share.viewer_personal,
    viewer_global: share.viewer_global,
    platform_default: share.platform_default,
  };
  return {
    rows: DEVELOPER_RATE_CARD_SHOWN_ROWS.map((row) => ({ row, sharePct: sharePct[row] })),
  };
}

/** For an editor acting on someone else's app: the owner, in whose name it publishes, must have accepted. */
export async function assertOwnerAcceptedAppDeveloperTerms(ownerUserId: number): Promise<void> {
  if (!(await hasAcceptedAppDeveloperTerms(ownerUserId))) {
    throw new TRPCError({ code: 'FORBIDDEN', message: appOwnerTermsRefusalMessage(getBaseUrl()) });
  }
}

/**
 * The listing's canonical owner (never a shadow's frozen `userId`) must have accepted. Skipped when
 * the owner is the acting user, whose own acceptance the caller checks.
 */
export async function assertListingOwnerAcceptedAppDeveloperTerms(
  appListingId: string,
  actingUserId?: number
): Promise<void> {
  const { resolveListingAccess } = await import('~/server/services/blocks/app-access.service');
  const ownerUserId = (await resolveListingAccess(appListingId, null))?.ownerUserId;
  if (ownerUserId != null && ownerUserId !== actingUserId)
    await assertOwnerAcceptedAppDeveloperTerms(ownerUserId);
}
