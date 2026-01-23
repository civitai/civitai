import type { NextApiRequest, NextApiResponse } from 'next';
import type { Readable } from 'node:stream';
import { env } from '~/env/server';
import { trackWebhookEvent } from '~/server/clickhouse/client';
import { dbWrite } from '~/server/db/client';
import tipaltiCaller from '~/server/http/tipalti/tipalti.caller';
import type { Tipalti } from '~/server/http/tipalti/tipalti.schema';
import { updateBuzzWithdrawalRequest } from '~/server/services/buzz-withdrawal-request.service';
import { updateCashWithdrawal, userCashCache } from '~/server/services/creator-program.service';
import { updateByTipaltiAccount } from '~/server/services/user-payment-configuration.service';
import { parseRefCodeToWithdrawalId } from '~/server/utils/creator-program.utils';
import type { CashWithdrawalMethod } from '~/shared/utils/prisma/enums';
import { BuzzWithdrawalRequestStatus, CashWithdrawalStatus } from '~/shared/utils/prisma/enums';

export const config = {
  api: {
    bodyParser: false,
  },
};

type TipaltiWebhookEventData = {
  id: string;
  type: Tipalti.TipaltiWebhookEventType;
  createdDate: string;
  isTest: boolean;
  version: string;
  traceId: string;
  eventData: Record<string, any>;
};

async function buffer(readable: Readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    console.log('chunk:', chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'POST') {
    const sig =
      req.headers['tipalti-signature'] ??
      req.headers['x-tipalti-signature'] ??
      req.headers['Tipalti-Signature'];

    const webhookSecret = env.TIPALTI_WEBTOKEN_SECRET;
    let event: TipaltiWebhookEventData;
    const buf = await buffer(req);
    const rawPayload = buf.toString('utf8');

    // Track to ClickHouse (fire and forget, never throws)
    trackWebhookEvent('tipalti', rawPayload).catch(() => {});

    try {
      if (!sig || !webhookSecret) {
        // only way this is false is if we forgot to include our secret or paddle decides to suddenly not include their signature
        return res.status(400).send({
          error: 'Invalid Request. Signature or Secret not found',
          sig,
        });
      }

      const client = await tipaltiCaller();
      const { isValid, ...data } = client.validateWebhookEvent(sig as string, rawPayload);
      const { isValid: isValid2, ...data2 } = client.validateWebhookEvent(
        sig as string,
        req.body as string
      );
      if (!isValid && !isValid2) {
        console.log('❌ Invalid signature');
        return res.status(400).send({
          error: 'Invalid Request. Could not validate Webhook signature',
          data,
          data2,
        });
      }

      event = JSON.parse(rawPayload) as TipaltiWebhookEventData;

      switch (event.type) {
        case 'payeeDetailsChanged':
          // Handle payee details changed event
          await updateByTipaltiAccount({
            // In this webhook, the payeeId is the refCode which is our userId, not the actual payeeId.
            userId: Number.parseInt(event.eventData.payeeId),
            tipaltiAccountStatus: event.eventData.status,
            tipaltiPaymentsEnabled: event.eventData.isPayable,
            tipaltiWithdrawalMethod: (event.eventData.paymentMethod ??
              event.eventData.paymentMethodType) as CashWithdrawalMethod,
          });
          break;
        case 'paymentGroupApproved':
        case 'paymentGroupDeclined':
          const payment = event.eventData.payments[0] as {
            refCode: string;
            paymentStatus: string;
          };

          if (payment.refCode.startsWith('CW')) {
            // Creator Program V2:
            await processCashWithdrawalEvent(event);
          } else {
            await processBuzzWithdrawalRequest(event);
          }

          break;

        case 'paymentCompleted':
        case 'paymentSubmitted':
        case 'paymentDeferred':
        case 'paymentCanceled':
        case 'paymentError': {
          const payment = event.eventData as { refCode: string; paymentStatus: string };

          if (payment.refCode.startsWith('CW')) {
            // Creator Program V2:
            await processCashWithdrawalEvent(event);
          } else {
            await processBuzzWithdrawalRequest(event);
          }
          break;
        }
        default:
          throw new Error('Unhandled relevant event!');
      }
    } catch (error: any) {
      console.log(`❌ Error message: ${error.message}`);
      return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    return res.status(200).json({ received: true });
  } else {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method Not Allowed');
  }
}

const processBuzzWithdrawalRequest = async (event: TipaltiWebhookEventData) => {
  const client = await tipaltiCaller();

  switch (event.type) {
    case 'paymentGroupApproved':
    case 'paymentGroupDeclined': {
      const payment = event.eventData.payments[0] as { refCode: string; paymentStatus: string };

      const request = await dbWrite.buzzWithdrawalRequest.findFirst({
        where: {
          transferId: payment.refCode,
        },
      });

      if (!request) {
        console.log(`❌ Withdrawal request not found for transferId: ${payment.refCode}`);
        throw new Error(`Withdrawal request not found for transferId: ${payment.refCode}`);
      }

      // Update the status of the withdrawal request:
      const status =
        event.type === 'paymentGroupApproved'
          ? BuzzWithdrawalRequestStatus.Approved
          : BuzzWithdrawalRequestStatus.Rejected;
      const metadata = {
        ...((request.metadata as MixedObject) ?? {}),
        paymentStatus: payment.paymentStatus,
        approvalDate: event.eventData.approvalDate,
      };
      const note = `Payment group ${
        event.type === 'paymentGroupApproved' ? 'approved' : 'declined'
      }. Payment status: ${payment.paymentStatus}`;

      await updateBuzzWithdrawalRequest({
        requestIds: [request.id],
        status,
        metadata,
        note,
        userId: -1, // Done by Webhook
      });

      break;
    }
    case 'paymentCompleted':
    case 'paymentSubmitted':
    case 'paymentDeferred':
    case 'paymentCanceled': {
      const payment = event.eventData as { refCode: string; paymentStatus: string };
      const request = await dbWrite.buzzWithdrawalRequest.findFirst({
        where: {
          transferId: payment.refCode,
        },
      });

      if (!request) {
        console.log(`❌ Withdrawal request not found for transferId: ${payment.refCode}`);
        throw new Error(`Withdrawal request not found for transferId: ${payment.refCode}`);
      }

      // Update the status of the withdrawal request:
      const status =
        event.type === 'paymentCompleted'
          ? BuzzWithdrawalRequestStatus.Transferred
          : event.type === 'paymentSubmitted'
          ? BuzzWithdrawalRequestStatus.Approved
          : //  paymentDeferred, paymentCanceled, both go to Rejected
            BuzzWithdrawalRequestStatus.Rejected;

      const metadata = {
        ...((request.metadata as MixedObject) ?? {}),
        cancelledDate: event.eventData.cancelledDate,
        errorDescription: event.eventData.errorDescription,
        errorCode: event.eventData.errorCode,
        errorDate: event.eventData.errorDate,
        deferredReasons: event.eventData.deferredReasons,
      };
      const note =
        event.type === 'paymentCompleted'
          ? 'Payment completed'
          : event.type === 'paymentDeferred'
          ? `Payment deferred. Reasons: ${event.eventData.deferredReasons
              .map((r: { reasonDescription: string }) => r.reasonDescription)
              .join(', ')}`
          : event.type === 'paymentSubmitted'
          ? 'Payment submitted'
          : 'Payment canceled';

      await updateBuzzWithdrawalRequest({
        requestIds: [request.id],
        status,
        metadata,
        note,
        userId: -1, // Done by Webhook
      });

      break;
    }
    case 'paymentError': {
      const payment = event.eventData as { refCode: string; paymentStatus: string };
      const request = await dbWrite.buzzWithdrawalRequest.findFirst({
        where: {
          transferId: payment.refCode,
        },
      });

      if (!request) {
        console.log(`❌ Withdrawal request not found for transferId: ${payment.refCode}`);
        throw new Error(`Withdrawal request not found for transferId: ${payment.refCode}`);
      }

      const paymentRecord = await client.getPaymentByRefCode(payment.refCode);

      if (!paymentRecord) {
        throw new Error('Could not fetch payment record');
      }

      const feesTotal = paymentRecord?.fees.reduce((acc, fee) => acc + fee.amount.amount, 0);
      // Update the status of the withdrawal request:

      await updateBuzzWithdrawalRequest({
        requestIds: [request.id],
        status: BuzzWithdrawalRequestStatus.Rejected,
        metadata: {
          ...((request.metadata as MixedObject) ?? {}),
          cancelledDate: event.eventData.cancelledDate,
          errorDescription: event.eventData.errorDescription,
          errorCode: event.eventData.errorCode,
          errorDate: event.eventData.errorDate,
          deferredReasons: event.eventData.deferredReasons,
        },
        note: `Payment error: ${event.eventData.errorDescription}`,
        userId: -1, // Done by Webhook
        refundFees: feesTotal * 1000,
      });

      break;
    }
  }
};

const processCashWithdrawalEvent = async (event: TipaltiWebhookEventData) => {
  const client = await tipaltiCaller();

  switch (event.type) {
    case 'paymentGroupApproved':
    case 'paymentGroupDeclined': {
      const payment = event.eventData.payments[0] as { refCode: string; paymentStatus: string };
      const { userId, idPart } = parseRefCodeToWithdrawalId(payment.refCode);

      if (!userId || !idPart) {
        console.log(`❌ Withdrawal request not found for transferId: ${payment.refCode}`);
        throw new Error(`Withdrawal request not found for transferId: ${payment.refCode}`);
      }

      const cashWithdrawal = await dbWrite.cashWithdrawal.findFirst({
        where: {
          userId,
          id: {
            startsWith: idPart,
          },
        },
      });

      if (!cashWithdrawal) {
        console.log(`❌ Withdrawal request not found for transferId: ${payment.refCode}`);
        throw new Error(`Withdrawal request not found for transferId: ${payment.refCode}`);
      }

      // Update the status of the withdrawal request:
      const status =
        event.type === 'paymentGroupApproved'
          ? CashWithdrawalStatus.Cleared
          : CashWithdrawalStatus.Rejected;

      const metadata = {
        ...((cashWithdrawal.metadata as MixedObject) ?? {}),
        paymentStatus: payment.paymentStatus,
        approvalDate: event.eventData.approvalDate,
      };

      const note =
        event.type === 'paymentGroupApproved'
          ? "Payment approved by Moderators. Tipalti's processing should start shortly."
          : `Payment has been declined. Please contact support.`;

      await updateCashWithdrawal({
        withdrawalId: cashWithdrawal.id,
        status,
        metadata,
        note,
      });

      await userCashCache.bust(cashWithdrawal.userId);

      break;
    }
    case 'paymentCompleted':
    case 'paymentSubmitted':
    case 'paymentDeferred':
    case 'paymentCanceled': {
      const payment = event.eventData as { refCode: string; paymentStatus: string };
      const { userId, idPart } = parseRefCodeToWithdrawalId(payment.refCode);

      if (!userId || !idPart) {
        console.log(`❌ Withdrawal request not found for transferId: ${payment.refCode}`);
        throw new Error(`Withdrawal request not found for transferId: ${payment.refCode}`);
      }

      const cashWithdrawal = await dbWrite.cashWithdrawal.findFirst({
        where: {
          userId,
          id: {
            startsWith: idPart,
          },
        },
      });

      if (!cashWithdrawal) {
        console.log(`❌ Withdrawal request not found for transferId: ${payment.refCode}`);
        throw new Error(`Withdrawal request not found for transferId: ${payment.refCode}`);
      }

      // Update the status of the withdrawal request:
      const status =
        event.type === 'paymentCompleted'
          ? CashWithdrawalStatus.Paid
          : event.type === 'paymentDeferred'
          ? CashWithdrawalStatus.Deferred
          : event.type === 'paymentSubmitted'
          ? CashWithdrawalStatus.Scheduled
          : CashWithdrawalStatus.Canceled;

      const metadata = {
        ...((cashWithdrawal.metadata as MixedObject) ?? {}),
        cancelledDate: event.eventData.cancelledDate,
        errorDescription: event.eventData.errorDescription,
        errorCode: event.eventData.errorCode,
        errorDate: event.eventData.errorDate,
        deferredReasons: event.eventData.deferredReasons,
      };

      const note =
        event.type === 'paymentCompleted'
          ? 'Payment completed'
          : event.type === 'paymentDeferred'
          ? `Payment deferred. Reasons: ${event.eventData.deferredReasons
              .map((r: { reasonDescription: string }) => r.reasonDescription)
              .join(', ')}`
          : event.type === 'paymentSubmitted'
          ? 'Your withdrawal has been scheduled! Tipalti will process it shortly, and you should receive your funds within 1–5 business days, depending on your payout method'
          : 'Payment canceled';

      await updateCashWithdrawal({
        withdrawalId: cashWithdrawal.id,
        status,
        metadata,
        note,
      });

      await userCashCache.bust(cashWithdrawal.userId);

      break;
    }
    case 'paymentError': {
      const payment = event.eventData as { refCode: string; paymentStatus: string };
      const { userId, idPart } = parseRefCodeToWithdrawalId(payment.refCode);

      if (!userId || !idPart) {
        console.log(`❌ Withdrawal request not found for transferId: ${payment.refCode}`);
        throw new Error(`Withdrawal request not found for transferId: ${payment.refCode}`);
      }

      const cashWithdrawal = await dbWrite.cashWithdrawal.findFirst({
        where: {
          userId,
          id: {
            startsWith: idPart,
          },
        },
      });

      if (!cashWithdrawal) {
        console.log(`❌ Withdrawal request not found for transferId: ${payment.refCode}`);
        throw new Error(`Withdrawal request not found for transferId: ${payment.refCode}`);
      }

      const paymentRecord = await client.getPaymentByRefCode(payment.refCode);

      if (!paymentRecord) {
        throw new Error('Could not fetch payment record');
      }

      const feesTotal = paymentRecord?.fees.reduce((acc, fee) => acc + fee.amount.amount, 0);

      await updateCashWithdrawal({
        withdrawalId: cashWithdrawal.id,
        status: CashWithdrawalStatus.Rejected,
        metadata: {
          ...((cashWithdrawal.metadata as MixedObject) ?? {}),
          cancelledDate: event.eventData.cancelledDate,
          errorDescription: event.eventData.errorDescription,
          errorCode: event.eventData.errorCode,
          errorDate: event.eventData.errorDate,
          deferredReasons: event.eventData.deferredReasons,
        },
        note: `Payment error: ${event.eventData.errorDescription}`,
        fees: feesTotal * 100,
      });

      await userCashCache.bust(cashWithdrawal.userId);
      break;
    }
  }
};
