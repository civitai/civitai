import Stripe from 'stripe';
import { env } from '../../env/server.mjs';
import { dbRead, dbWrite } from '../db/client';
import { logToAxiom } from '../logging/client';
import { throwBadRequestError } from '../utils/errorHandling';
import { getServerStripe } from '../utils/get-server-stripe';
import { StripeConnectStatus, UserStripeConnect } from '@prisma/client';
import { createNotification } from './notification.service';
import { number } from 'zod';

// Since these are stripe connect related, makes sense to log for issues for visibility.
const log = (data: MixedObject) => {
  logToAxiom({ name: 'stripe-connect', type: 'error', ...data }).catch();
};

export async function getUserStripeConnectAccount({ userId }: { userId: number }) {
  return dbRead.userStripeConnect.findUniqueOrThrow({
    where: { userId },
  });
}

export async function createUserStripeConnectAccount({ userId }: { userId: number }) {
  const stripe = await getServerStripe();
  const user = await dbRead.user.findUnique({ where: { id: userId } });

  if (!user) throw throwBadRequestError(`User not found: ${userId}`);

  const existingStripeConnectAccount = await dbRead.userStripeConnect.findFirst({
    where: { userId },
  });

  if (existingStripeConnectAccount) {
    return existingStripeConnectAccount;
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

    const userStripeConnect = await dbWrite.userStripeConnect.create({
      data: {
        userId,
        connectedAccountId: connectedAccount.id,
      },
    });

    return userStripeConnect;
  } catch (error) {
    log({ method: 'createUserStripeConnectAccount', error, userId });
    throw error;
  }
}

export async function getStripeConnectOnboardingLink({ userId }: { userId: number }) {
  if (!env.NEXT_PUBLIC_BASE_URL) throw throwBadRequestError('NEXT_PUBLIC_BASE_URL not set');

  const userStripeConnect = await getUserStripeConnectAccount({ userId });
  const stripe = await getServerStripe();
  const accountLink = await stripe.accountLinks.create({
    account: userStripeConnect.connectedAccountId,
    refresh_url: `${env.NEXT_PUBLIC_BASE_URL}/user/stripe-connect/onboard`,
    return_url: `${env.NEXT_PUBLIC_BASE_URL}/user/account#stripe`,
    type: 'account_onboarding',
  });

  return accountLink;
}

export async function updateByStripeConnectAccount({
  stripeAccount,
}: {
  stripeAccount: Stripe.Account;
}) {
  const userStripeConnect = await dbWrite.userStripeConnect.findUnique({
    where: { connectedAccountId: stripeAccount.id },
  });

  if (!userStripeConnect) throw throwBadRequestError('User stripe connect account not found');

  let updated: UserStripeConnect = userStripeConnect;

  const data = {
    payoutsEnabled: stripeAccount.payouts_enabled,
    // Mainly a future-proofing, we're not doing charges really, but might be good to store.
    chargesEnabled: stripeAccount.charges_enabled,
  };

  if (stripeAccount.payouts_enabled && userStripeConnect.status !== StripeConnectStatus.Approved) {
    // If we're here, user is good to go!

    updated = await dbWrite.userStripeConnect.update({
      where: { connectedAccountId: stripeAccount.id },
      data: {
        status: StripeConnectStatus.Approved,
        ...data,
      },
    });

    await createNotification({
      userId: userStripeConnect.userId,
      type: 'creators-program-payments-enabled',
    }).catch();
  } else if (
    stripeAccount.requirements?.disabled_reason &&
    userStripeConnect.status !== StripeConnectStatus.Rejected
  ) {
    // If we're here, user is not good to go!
    updated = await dbWrite.userStripeConnect.update({
      where: { connectedAccountId: stripeAccount.id },
      data: {
        status: StripeConnectStatus.Rejected,
        ...data,
      },
    });

    await createNotification({
      userId: userStripeConnect.userId,
      type: 'creators-program-rejected-stripe',
    }).catch();
  } else {
    updated = await dbWrite.userStripeConnect.update({
      where: { connectedAccountId: stripeAccount.id },
      data: {
        status: StripeConnectStatus.PendingVerification,
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
}: {
  byUserId: number;
  toUserId: number;
  amount: number;
  description: string;
}) => {
  const stripe = await getServerStripe();
  const toUserStripeConnect = await getUserStripeConnectAccount({ userId: toUserId });

  try {
    const transfer = await stripe.transfers.create({
      amount,
      currency: 'usd',
      destination: toUserStripeConnect.connectedAccountId,
      description,
      metadata: {
        byUserId: byUserId.toString(),
        toUserId: toUserId.toString(),
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
