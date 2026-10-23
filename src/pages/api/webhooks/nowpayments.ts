import type { NextApiRequest, NextApiResponse } from 'next';
import { instrumentApiResponse } from '~/server/prom/http-errors';
import { env } from '~/env/server';
import { trackWebhookEvent } from '~/server/clickhouse/client';
import client from '~/server/http/nowpayments/nowpayments.caller';
import { NOWPayments } from '~/server/http/nowpayments/nowpayments.schema';
import { isDepositComplete } from '~/server/common/chain-config';
import { logToAxiom } from '~/server/logging/client';
import {
  isDepositCredited,
  processDeposit,
  recordUnverifiedDeposit,
} from '~/server/services/nowpayments.service';

export const config = {
  api: {
    bodyParser: true,
  },
};

const log = (data: MixedObject) => {
  logToAxiom({ name: 'nowpayments-webhook', type: 'error', ...data }).catch(() => null);
};

const ACTIONABLE_STATUSES = ['confirming', 'finished', 'partially_paid', 'failed'];

const eventFromPayment = (
  payment: NOWPayments.CreatePaymentResponse
): NOWPayments.WebhookEvent => ({
  payment_id:
    typeof payment.payment_id === 'string' ? parseInt(payment.payment_id, 10) : payment.payment_id,
  payment_status: payment.payment_status,
  order_id: payment.order_id,
  outcome_amount: payment.outcome_amount,
  actually_paid: payment.actually_paid ? Number(payment.actually_paid) : undefined,
  pay_currency: payment.pay_currency,
  pay_address: payment.pay_address,
  parent_payment_id: payment.parent_payment_id,
  payin_hash: payment.payin_hash,
});

const VERIFIED_FIELDS = ['payment_status', 'order_id', 'outcome_amount'] as const;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Count any 5xx this webhook emits into civitai_app_http_errors_total — these
  // handlers bypass the endpoint wrappers, so their 500s were counter-blind.
  // Listener-only (res.once('finish')); no behavior/response change.
  instrumentApiResponse(req, res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method Not Allowed');
  }

  const sig = req.headers['x-nowpayments-sig'];
  const webhookSecret = env.NOW_PAYMENTS_IPN_KEY;

  // Track to ClickHouse (fire and forget, never throws)
  trackWebhookEvent('nowpayments', JSON.stringify(req.body)).catch(() => null);

  try {
    if (!sig || !webhookSecret) {
      log({
        message: 'Invalid request: Missing signature or secret',
      });
      return res.status(400).send({
        error: 'Invalid Request. Signature or Secret not found',
      });
    }

    const { isValid } = client.validateWebhookEvent(sig as string, req.body);
    if (!isValid) {
      log({ message: 'Invalid signature' });
      return res.status(400).send({
        error: 'Invalid Request. Could not validate Webhook signature',
      });
    }

    const event = NOWPayments.webhookSchema.parse(req.body);
    const paymentStatus = event.payment_status;

    if (!paymentStatus || !event.payment_id) {
      log({
        message: 'Webhook missing payment_status or payment_id',
        event,
      });
      return res.status(400).send({ error: 'Missing payment_status or payment_id' });
    }

    // The IPN only says which payment to look at; what is recorded and credited comes from
    // NOWPayments' own record of it. partially_paid is credited like finished; failed records the
    // status and credits nothing.
    // A credited deposit has nothing left to learn; a replay must not spend a lookup.
    if (ACTIONABLE_STATUSES.includes(paymentStatus) && !(await isDepositCredited(event.payment_id))) {
      const { payment, status: lookupStatus } = await client
        .lookupPayment(event.payment_id)
        .catch((e) => {
          log({ stage: 'payment-status-failed', paymentId: event.payment_id, error: e.message });
          return { payment: null, status: 0 };
        });
      const verified = payment ? eventFromPayment(payment) : null;
      // NOWPayments' record can trail its own IPN. A paid IPN it cannot confirm yet is handed to
      // the retry sweep, and the 400 asks NOWPayments to redeliver.
      const unconfirmed = !payment
        ? lookupStatus === 404
          ? 'not-found'
          : `lookup-failed-${lookupStatus}`
        : verified?.payment_id !== event.payment_id
        ? 'different-payment'
        : isDepositComplete(paymentStatus) && !isDepositComplete(payment.payment_status)
        ? 'not-complete'
        : null;
      if (!payment || !verified || unconfirmed) {
        log({
          stage: 'payment-verify-unavailable',
          paymentId: event.payment_id,
          reason: unconfirmed,
        });
        if (isDepositComplete(paymentStatus)) await recordUnverifiedDeposit(event);
        throw new Error(
          `Payment ${event.payment_id} not confirmed by NOWPayments (${unconfirmed})`
        );
      }

      const mismatched = VERIFIED_FIELDS.filter(
        (field) => (event[field] ?? null) !== (verified[field] ?? null)
      );
      if (mismatched.length) {
        log({
          type: 'warning',
          stage: 'payment-mismatch',
          paymentId: event.payment_id,
          fields: mismatched,
        });
      }

      const status = payment.payment_status;
      if (ACTIONABLE_STATUSES.includes(status)) {
        await processDeposit(event.payment_id, status, verified);
      }
    }
  } catch (error: any) {
    const body = req.body ?? {};
    log({
      message: `Webhook error: ${error.message}`,
      error: error.stack,
      payload: {
        payment_id: body.payment_id,
        payment_status: body.payment_status,
        order_id: body.order_id,
        pay_currency: body.pay_currency,
        actually_paid: body.actually_paid,
        outcome_amount: body.outcome_amount,
      },
    });
    return res.status(400).send('Webhook Error');
  }

  return res.status(200).json({ received: true });
}
