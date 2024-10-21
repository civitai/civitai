import { NextApiRequest, NextApiResponse } from 'next';
import { env } from '~/env/server.mjs';
import { Readable } from 'node:stream';
import tipaltiCaller from '~/server/http/tipalti/tipalti.caller';
import { updateByTipaltiAccount } from '~/server/services/user-payment-configuration.service';
import { dbRead } from '~/server/db/client';
import { BuzzWithdrawalRequestStatus } from '@prisma/client';
import { updateBuzzWithdrawalRequest } from '~/server/services/buzz-withdrawal-request.service';

async function buffer(readable: Readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks);
}

type TipaltiWebhookEvent = {
  id: string;
  type: string;
  createdDate: string;
  isTest: boolean;
  version: string;
  traceId: string;
  eventData: Record<string, any>;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'POST') {
    const sig = req.headers['tipalti-signature'];
    const webhookSecret = env.TIPALTI_WEBTOKEN_SECRET;
    const buf = await buffer(req);
    let event: TipaltiWebhookEvent;

    console.log(req.headers, sig);
    try {
      if (!sig || !webhookSecret) {
        // only way this is false is if we forgot to include our secret or paddle decides to suddenly not include their signature
        return res.status(400).send({
          error: 'Invalid Request',
        });
      }

      const client = await tipaltiCaller();

      const isValid = client.validateWebhookEvent(sig as string, JSON.stringify(req.body));
      if (!isValid) {
        console.log('❌ Invalid signature');
        return res.status(400).send({
          error: 'Invalid Request',
        });
      }

      event = req.body as TipaltiWebhookEvent;

      console.log(event.type);

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
            requestId: request.id,
            status,
            metadata,
            note,
            userId: -1, // Done by Webhook
          });

          break;
        }
        case 'paymentCompleted':
        case 'paymentError':
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
              : event.type === 'paymentError' || event.type === 'paymentDeferred'
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
              : event.type === 'paymentError'
              ? `Payment error: ${event.eventData.errorDescription}`
              : event.type === 'paymentDeferred'
              ? `Payment deferred. Reasons: ${event.eventData.deferredReasons
                  .map((r) => r.reasonDescription)
                  .join(', ')}`
              : 'Payment canceled';

          await updateBuzzWithdrawalRequest({
            requestId: request.id,
            status,
            metadata,
            note,
            userId: -1, // Done by Webhook
          });

          break;
        }
        default:
          throw new Error('Unhandled relevant event!');
          break;
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
