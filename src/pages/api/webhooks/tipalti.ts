import { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'node:stream';
import { env } from '~/env/server';
import { dbRead } from '~/server/db/client';
import tipaltiCaller from '~/server/http/tipalti/tipalti.caller';
import { updateBuzzWithdrawalRequest } from '~/server/services/buzz-withdrawal-request.service';
import { updateByTipaltiAccount } from '~/server/services/user-payment-configuration.service';
import { BuzzWithdrawalRequestStatus } from '~/shared/utils/prisma/enums';

export const config = {
  api: {
    bodyParser: false,
  },
};

type TipaltiWebhookEvent = {
  id: string;
  type: string;
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
    let event: TipaltiWebhookEvent;
    const buf = await buffer(req);

    try {
      if (!sig || !webhookSecret) {
        // only way this is false is if we forgot to include our secret or paddle decides to suddenly not include their signature
        return res.status(400).send({
          error: 'Invalid Request. Signature or Secret not found',
          sig,
        });
      }

      const buffAsString = buf.toString('utf8');
      const client = await tipaltiCaller();
      const { isValid, ...data } = client.validateWebhookEvent(sig as string, buffAsString);
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

      event = JSON.parse(buffAsString) as TipaltiWebhookEvent;

      switch (event.type) {
        case 'payeeDetailsChanged':
          // Handle payee details changed event
          await updateByTipaltiAccount({
            // In this webhook, the payeeId is the refCode which is our userId, not the actual payeeId.
            userId: Number.parseInt(event.eventData.payeeId),
            tipaltiAccountStatus: event.eventData.status,
            tipaltiPaymentsEnabled: event.eventData.isPayable,
          });
          break;
        case 'paymentGroupApproved':
        case 'paymentGroupDeclined': {
          const payment = event.eventData.payments[0] as { refCode: string; paymentStatus: string };
          const request = await dbRead.buzzWithdrawalRequest.findFirst({
            where: {
              transferId: payment.refCode,
            },
          });

          if (!request) {
            console.log(`❌ Withdrawal request not found for transferId: ${payment.refCode}`);
            return res
              .status(400)
              .send(`Withdrawal request not found for transferId: ${payment.refCode}`);
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
          const request = await dbRead.buzzWithdrawalRequest.findFirst({
            where: {
              transferId: payment.refCode,
            },
          });

          if (!request) {
            console.log(`❌ Withdrawal request not found for transferId: ${payment.refCode}`);
            return res
              .status(400)
              .send(`Withdrawal request not found for transferId: ${payment.refCode}`);
          }

          // Update the status of the withdrawal request:
          const status =
            event.type === 'paymentCompleted'
              ? BuzzWithdrawalRequestStatus.Transferred
              : event.type === 'paymentDeferred' || event.type === 'paymentSubmitted'
              ? BuzzWithdrawalRequestStatus.Approved
              : BuzzWithdrawalRequestStatus.Rejected;

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
          const request = await dbRead.buzzWithdrawalRequest.findFirst({
            where: {
              transferId: payment.refCode,
            },
          });

          if (!request) {
            console.log(`❌ Withdrawal request not found for transferId: ${payment.refCode}`);
            return res
              .status(400)
              .send(`Withdrawal request not found for transferId: ${payment.refCode}`);
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
