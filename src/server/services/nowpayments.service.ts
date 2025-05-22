import { env } from 'process';
import { logToAxiom } from '../logging/client';
import { TransactionType } from '../schema/buzz.schema';
import { createBuzzTransaction } from './buzz.service';
import nowpaymentsCaller from '~/server/http/nowpayments/nowpayments.caller';
import Decimal from 'decimal.js';
import { CreatePaymentInvoiceInput } from '~/server/schema/nowpayments.schema';
import { NOW_PAYMENTS_FIXED_FEE } from '~/server/common/constants';

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
  const alertStatus = true; // ['partially_paid', 'confirmed'].includes(payment.payment_status);
  if (isPaid) {
    const [userId, buzzAmount] = payment.order_id.split('-').map((x) => parseInt(x));

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
  } else if (alertStatus) {
    log({
      message: 'Payment status alert',
      payment,
    });
  } else {
    console.log('Payment not finished', payment);
  }
};
