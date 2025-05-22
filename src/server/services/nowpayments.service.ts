import { env } from 'process';
import { logToAxiom } from '../logging/client';
import { TransactionType } from '../schema/buzz.schema';
import { createBuzzTransaction } from './buzz.service';
import nowpaymentsCaller from '~/server/http/nowpayments/nowpayments.caller';
import Decimal from 'decimal.js';
import { CreatePaymentInvoiceInput } from '~/server/schema/nowpayments.schema';
import { NOW_PAYMENTS_FIXED_FEE } from '~/server/common/constants';
import { createNotification } from '~/server/services/notification.service';
import { NotificationCategory } from '~/server/common/enums';

const log = (data: MixedObject) => {
  logToAxiom({ name: 'nowpayments-service', type: 'error', ...data }).catch();
};

export const createBuzzOrder = async (input: CreatePaymentInvoiceInput & { userId: number }) => {
  const callbackUrl =
    `${env.NEXTAUTH_URL}/api/webhooks/nowpayments?` +
    new URLSearchParams([['buzzAmount', input.buzzAmount.toString()]]);

  const successUrl =
    `${env.NEXTAUTH_URL}/payment/nowpayments?` +
    new URLSearchParams([['buzzAmount', input.buzzAmount.toString()]]);

  const orderId = `${input.userId}-${input.buzzAmount}-${new Date().getTime()}`;

  const invoice = await nowpaymentsCaller.createPaymentInvoice({
    price_amount: new Decimal(input.unitAmount + NOW_PAYMENTS_FIXED_FEE).dividedBy(100).toNumber(), // Nowpayuemnts use actual amount. Not multiplied by 100
    price_currency: 'usd',
    order_id: orderId,
    order_description: `Buzz purchase for ${input.buzzAmount} BUZZ`,
    ipn_callback_url: callbackUrl,
    success_url: successUrl,
    cancel_url: env.NEXTAUTH_URL,

    // is_fixed_rate: false,
    // is_fee_paid_by_user: true,
  });

  if (!invoice) {
    throw new Error('Failed to create invoice');
  }

  return invoice;
};

export const processBuzzOrder = async (paymentId: string | number) => {
  const payment = await nowpaymentsCaller.getPaymentStatus(paymentId);

  if (!payment) {
    log({
      message: 'Failed to retrieve payment status',
      paymentId,
    });
    throw new Error('Could not retrieve invoice data');
  }

  const isPaid = payment.payment_status === 'finished';
  const isPartiallyPaid = payment.payment_status === 'partially_paid';
  const [userId, buzzAmount] = payment.order_id.split('-').map((x) => parseInt(x));
  if (isPaid) {
    try {
      if (!buzzAmount || !userId) {
        await log({
          message: 'Buzz amount or user ID not found in order ID',
          payment,
        });

        throw new Error('Invalid order ID format. Please contact support.');
      }

      // Give user the buzz assuming it hasn't been given
      const { transactionId } = await createBuzzTransaction({
        fromAccountId: 0,
        toAccountId: userId,
        amount: buzzAmount,
        type: TransactionType.Purchase,
        externalTransactionId: payment.order_id,
        description: 'Buzz purchase',
        details: { invoiceId: payment.invoice_id, paymentId: payment.payment_id },
      });

      if (!transactionId) {
        throw new Error('Failed to create Buzz transaction');
      }
    } catch (error) {
      log({
        message: 'Failed to process payment',
        payment,
        error,
      });
    }
  } else if (isPartiallyPaid) {
    try {
      const estimate = await nowpaymentsCaller.getPriceEstimate({
        amount: payment?.price_amount as number,
        currency_from: 'usd', // We only do USD
        currency_to: payment?.pay_currency as string,
      });

      if (!estimate) {
        throw new Error('Failed to get estimate');
      }

      const ratio = new Decimal(estimate?.estimated_amount).dividedBy(
        new Decimal(estimate?.amount_from)
      );

      const buzzValueUsd = new Decimal(payment.actually_paid as string | number).dividedBy(ratio);

      const buzzAmount = Number(payment?.order_id.split('-')[1] as string);
      const estimateToBuzz = Math.floor(buzzValueUsd.mul(1000).toNumber());
      const toPay = Math.min(estimateToBuzz, buzzAmount);

      const isPartial = toPay < buzzAmount;
      // Give user the buzz assuming it hasn't been given
      const { transactionId } = await createBuzzTransaction({
        fromAccountId: 0,
        toAccountId: userId,
        amount: toPay,
        type: TransactionType.Purchase,
        externalTransactionId: `${payment.order_id}-${payment.payment_id}`,
        description: isPartial
          ? 'Buzz purchase'
          : 'Buzz purchase (partial). You’ve been credited Buzz based on the amount received.',
        details: { invoiceId: payment.invoice_id, paymentId: payment.payment_id },
      });

      if (!transactionId) {
        throw new Error('Failed to create Buzz transaction');
      }

      await createNotification({
        type: 'partially-paid',
        userId,
        category: NotificationCategory.Buzz,
        key: payment.order_id,
        details: {},
      });
    } catch (error) {
      log({
        message: 'Failed to process payment',
        payment,
        error,
        isPartiallyPaid,
      });
    }
  }
};
