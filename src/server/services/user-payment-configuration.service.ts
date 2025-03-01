import Stripe from 'stripe';
import { v4 as uuid } from 'uuid';
import { NotificationCategory, StripeConnectStatus, TipaltiStatus } from '~/server/common/enums';
import { env } from '../../env/server';
import { dbRead, dbWrite } from '../db/client';
import { logToAxiom } from '../logging/client';
import { throwBadRequestError } from '../utils/errorHandling';
import { getServerStripe } from '../utils/get-server-stripe';
import { createNotification } from './notification.service';
import { UserPaymentConfiguration } from '~/shared/utils/prisma/models';
import tipaltiCaller from '~/server/http/tipalti/tipalti.caller';
import { GetTipaltiDashbordUrlSchema } from '~/server/schema/user-payment-configuration.schema';
import { CashWithdrawalMethod } from '~/shared/utils/prisma/enums';

// Since these are stripe connect related, makes sense to log for issues for visibility.
const log = (data: MixedObject) => {
  logToAxiom({ name: 'user-payment-configuration', type: 'error', ...data }).catch();
};

export async function getUserPaymentConfiguration({ userId }: { userId: number }) {
  return dbRead.userPaymentConfiguration.findUnique({ where: { userId } });
}

export async function createStripeConnectAccount({ userId }: { userId: number }) {
  const stripe = await getServerStripe();
  if (!stripe) throw throwBadRequestError('Stripe not available');
  const user = await dbRead.user.findUnique({ where: { id: userId } });

  if (!user) throw throwBadRequestError(`User not found: ${userId}`);

  const existingConfig = await dbRead.userPaymentConfiguration.findFirst({
    where: { userId },
  });

  if (existingConfig && existingConfig.stripeAccountId) {
    return existingConfig;
  }

  try {
    const connectedAccount = await stripe.accounts.create({
      type: 'express',
      settings: {
        payouts: {
          schedule: {
            interval: 'manual',
          },
        },
      },
      metadata: {
        userId: user.id.toString(),
      },
    });

    const userStripeConnect = await dbWrite.userPaymentConfiguration.upsert({
      create: {
        userId,
        stripeAccountId: connectedAccount.id,
      },
      update: {
        stripeAccountId: connectedAccount.id,
      },
      where: {
        userId,
      },
    });

    return userStripeConnect;
  } catch (error) {
    log({ method: 'createStripeConnectAccount', error, userId });
    throw error;
  }
}

export async function getStripeConnectOnboardingLink({ userId }: { userId: number }) {
  if (!env.NEXT_PUBLIC_BASE_URL) throw throwBadRequestError('NEXT_PUBLIC_BASE_URL not set');

  const userPaymentConfig = await getUserPaymentConfiguration({ userId });
  if (!userPaymentConfig || !userPaymentConfig.stripeAccountId)
    throw throwBadRequestError('User stripe connect account not found');

  const stripe = await getServerStripe();

  if (!stripe) throw throwBadRequestError('Stripe not available');

  const accountLink = await stripe.accountLinks.create({
    account: userPaymentConfig.stripeAccountId,
    refresh_url: `${env.NEXT_PUBLIC_BASE_URL}/user/stripe-connect/onboard`,
    return_url: `${env.NEXT_PUBLIC_BASE_URL}/user/account#payments`,
    type: 'account_onboarding',
  });

  return accountLink;
}

export async function updateByStripeConnectAccount({
  stripeAccount,
}: {
  stripeAccount: Stripe.Account;
}) {
  const userPaymentConfig = await dbWrite.userPaymentConfiguration.findUnique({
    where: { stripeAccountId: stripeAccount.id },
  });

  if (!userPaymentConfig) throw throwBadRequestError('User stripe connect account not found');

  let updated: UserPaymentConfiguration = userPaymentConfig;

  const data = {
    stripePaymentsEnabled: stripeAccount.payouts_enabled,
  };

  if (stripeAccount.payouts_enabled && stripeAccount.details_submitted) {
    // If we're here, user is good to go!

    updated = await dbWrite.userPaymentConfiguration.update({
      where: { stripeAccountId: stripeAccount.id },
      data: {
        stripeAccountStatus: StripeConnectStatus.Approved,
        ...data,
      },
    });

    if (userPaymentConfig.stripeAccountStatus !== StripeConnectStatus.Approved) {
      await createNotification({
        userId: userPaymentConfig.userId,
        type: 'creators-program-payments-enabled',
        category: NotificationCategory.System,
        key: `creators-program-payments-enabled:${uuid()}`,
        details: {},
      }).catch();
    }
  } else if (stripeAccount.requirements?.disabled_reason) {
    // If we're here, user is not good to go!
    updated = await dbWrite.userPaymentConfiguration.update({
      where: { stripeAccountId: stripeAccount.id },
      data: {
        stripeAccountStatus: StripeConnectStatus.Rejected,
        ...data,
      },
    });

    if (userPaymentConfig.stripeAccountStatus !== StripeConnectStatus.Rejected) {
      await createNotification({
        userId: userPaymentConfig.userId,
        type: 'creators-program-rejected-stripe',
        category: NotificationCategory.System,
        key: `creators-program-rejected-stripe:${uuid()}`,
        details: {},
      }).catch();
    }
  } else if (stripeAccount.details_submitted) {
    updated = await dbWrite.userPaymentConfiguration.update({
      where: { stripeAccountId: stripeAccount.id },
      data: {
        stripeAccountStatus: StripeConnectStatus.PendingVerification,
        ...data,
      },
    });
  }

  return updated;
}

export const payToStripeConnectAccount = async ({
  byUserId,
  toUserId,
  amount,
  description,
  metadata,
}: {
  byUserId: number;
  toUserId: number;
  amount: number;
  description: string;
  metadata?: MixedObject;
}) => {
  const stripe = await getServerStripe();
  if (!stripe) throw throwBadRequestError('Stripe not available');

  const toUserPaymentConfig = await getUserPaymentConfiguration({ userId: toUserId });
  if (!toUserPaymentConfig || !toUserPaymentConfig.stripeAccountId)
    throw throwBadRequestError('User stripe connect account not found');

  if (!toUserPaymentConfig.stripePaymentsEnabled)
    throw throwBadRequestError('User stripe connect account not enabled for payments');

  try {
    const transfer = await stripe.transfers.create({
      amount,
      currency: 'usd',
      destination: toUserPaymentConfig.stripeAccountId,
      description,
      metadata: {
        byUserId: byUserId.toString(),
        toUserId: toUserId.toString(),
        ...(metadata ?? {}),
      },
    });

    return transfer;
  } catch (error) {
    log({ method: 'payToStripeConnectAccount', error, byUserId, toUserId, amount, description });
    throw error;
  }
};

export const revertStripeConnectTransfer = async ({ transferId }: { transferId: string }) => {
  const stripe = await getServerStripe();
  if (!stripe) throw throwBadRequestError('Stripe not available');

  try {
    const transfer = await stripe.transfers.retrieve(transferId, {
      expand: ['reversals'],
    });

    if (transfer.reversed) {
      return transfer.reversals.data[0];
    }

    const reversal = await stripe.transfers.createReversal(transferId);

    return reversal;
  } catch (error) {
    log({ method: 'revertStripeConnectTransfer', error, transferId });
    throw error;
  }
};

export async function createTipaltiPayee({ userId }: { userId: number }) {
  const client = await tipaltiCaller();
  if (!client) {
    throw throwBadRequestError('Tipalti not available');
  }

  const user = await dbRead.user.findUnique({ where: { id: userId } });

  if (!user) throw throwBadRequestError(`User not found: ${userId}`);

  const existingConfig = await dbRead.userPaymentConfiguration.findFirst({
    where: { userId },
  });

  if (existingConfig && existingConfig.tipaltiAccountId) {
    return existingConfig;
  }

  try {
    const tipaltiPayee = await client.createPayee({
      refCode: user.id.toString(),
      entityType: 'INDIVIDUAL',
      contactInformation: {
        email: user.email as string,
      },
    });

    // Send invite right away:
    // TODO: store some info on the meta object.
    const invitation = await client.createPayeeInvitation(tipaltiPayee.id);

    const updatedPaymentConfiguration = await dbWrite.userPaymentConfiguration.upsert({
      create: {
        userId,
        tipaltiAccountId: tipaltiPayee.id,
      },
      update: {
        tipaltiAccountId: tipaltiPayee.id,
      },
      where: {
        userId,
      },
    });

    return updatedPaymentConfiguration;
  } catch (error) {
    log({ method: 'createTipaltiPayee', error, userId });
    throw error;
  }
}

export async function updateByTipaltiAccount({
  tipaltiAccountId,
  tipaltiAccountStatus,
  tipaltiPaymentsEnabled,
  tipaltiWithdrawalMethod,
  userId,
}: {
  tipaltiAccountId?: string;
  tipaltiAccountStatus: TipaltiStatus;
  tipaltiPaymentsEnabled: boolean;
  tipaltiWithdrawalMethod?: CashWithdrawalMethod;
  userId?: number;
}) {
  const userPaymentConfig = await dbWrite.userPaymentConfiguration.findUnique({
    where: { tipaltiAccountId, userId },
  });

  if (!userPaymentConfig) throw throwBadRequestError('User tipalti account not found');

  let updated: UserPaymentConfiguration = userPaymentConfig;

  const data = {
    tipaltiAccountStatus,
    tipaltiPaymentsEnabled,
    tipaltiWithdrawalMethod,
  };

  updated = await dbWrite.userPaymentConfiguration.update({
    where: { tipaltiAccountId, userId },
    data: {
      ...data,
    },
  });

  if (tipaltiPaymentsEnabled) {
    if (userPaymentConfig.tipaltiAccountStatus !== TipaltiStatus.Active) {
      await createNotification({
        userId: userPaymentConfig.userId,
        type: 'creators-program-payments-enabled',
        category: NotificationCategory.System,
        key: `creators-program-payments-enabled:${uuid()}`,
        details: {},
      }).catch();
    }
  } else if (
    tipaltiAccountStatus === TipaltiStatus.BlockedByTipalti ||
    tipaltiAccountStatus === TipaltiStatus.Blocked
  ) {
    await createNotification({
      userId: userPaymentConfig.userId,
      type: 'creators-program-rejected-stripe',
      category: NotificationCategory.System,
      key: `creators-program-rejected-stripe:${uuid()}`,
      details: {},
    }).catch();
  }

  return updated;
}

export async function getTipaltiDashboardUrl({
  type,
  userId,
}: GetTipaltiDashbordUrlSchema & { userId: number }) {
  const userPaymentConfig = await getUserPaymentConfiguration({ userId });
  if (!userPaymentConfig || !userPaymentConfig.tipaltiAccountId)
    throw throwBadRequestError('User tipalti account not found');

  const client = await tipaltiCaller();
  const accountLink = await client.getPaymentDashboardUrl(userId.toString(), type);

  return accountLink;
}
export const payToTipaltiAccount = async ({
  byUserId,
  toUserId,
  amount,
  description,
  requestId,
}: {
  requestId: string;
  byUserId: number;
  toUserId: number;
  amount: number;
  description: string;
}) => {
  const toUserPaymentConfig = await getUserPaymentConfiguration({ userId: toUserId });
  if (!toUserPaymentConfig || !toUserPaymentConfig.tipaltiAccountId)
    throw throwBadRequestError('User tipalti account not found');

  if (!toUserPaymentConfig.tipaltiPaymentsEnabled)
    throw throwBadRequestError('User tipalti account not enabled for payments');

  const client = await tipaltiCaller();
  const key = `${requestId.slice(0, 16)}`;

  try {
    const paymentBatch = await client.createPaymentBatch([
      {
        payeeId: toUserPaymentConfig.tipaltiAccountId,
        amountSubmitted: {
          currency: 'USD',
          amount,
        },
        refCode: key,
      },
    ]);

    return {
      paymentBatchId: paymentBatch.id,
      paymentRefCode: key,
    };
  } catch (error) {
    log({ method: 'payToStripeConnectAccount', error, byUserId, toUserId, amount, description });
    throw error;
  }
};
