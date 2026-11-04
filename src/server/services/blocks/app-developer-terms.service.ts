import { TRPCError } from '@trpc/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { ACTIVE_RATE_CARD } from '~/server/services/blocks/rate-card';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { BLOCK_GOOD_APP_OWNER_SHARE } from '~/shared/constants/block-goods.constants';
import {
  APP_DEVELOPER_TERMS_VERSION,
  appDeveloperTermsRefusalMessage,
} from '~/shared/constants/app-developer-terms.constants';

export class AppDeveloperTermsNotAcceptedError extends Error {
  constructor() {
    super(appDeveloperTermsRefusalMessage(getBaseUrl()));
    this.name = 'AppDeveloperTermsNotAcceptedError';
  }
}

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
  if (!(await hasAcceptedAppDeveloperTerms(userId))) throw new AppDeveloperTermsNotAcceptedError();
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
 * is what is paid. Memberships are left off while their share is a placeholder.
 */
export function getDeveloperRateCard() {
  const share = ACTIVE_RATE_CARD.publisherSharePctByScope;
  return {
    version: ACTIVE_RATE_CARD.version,
    effectiveFrom: ACTIVE_RATE_CARD.effectiveFrom,
    goodsOwnerSharePct: Math.round(BLOCK_GOOD_APP_OWNER_SHARE * 100),
    buzzPurchaseSharePct: {
      publisher_all_my_models: share.publisher_all_my_models,
      viewer_personal: share.viewer_personal,
      platform_default: share.platform_default,
      viewer_global: share.viewer_global,
    },
  };
}
