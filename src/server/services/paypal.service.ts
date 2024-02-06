import { env } from '~/env/server.mjs';
import { constants } from '../common/constants';
import { isDev } from '~/env/other';
import { createBuzzTransaction } from './buzz.service';
import { TransactionType } from '../schema/buzz.schema';
import { throwBadRequestError } from '../utils/errorHandling';
import { PaypalPurchaseBuzzSchema } from '../schema/paypal.schema';
import { logToAxiom } from '../logging/client';

const PAYPAL_URL = isDev ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
const Authorization = `Basic ${Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_SECRET}`).toString(
  'base64'
)}`;
const log = (data: MixedObject) => {
  logToAxiom({ name: 'paypal-service', type: 'error', ...data }).catch();
};

export const createBuzzOrder = async ({ amount, userId }: PaypalPurchaseBuzzSchema) => {
  const response = await fetch(`${PAYPAL_URL}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization,
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: `${userId}:${amount}`,
          description: `Individual Buzz purchase - ${amount} Buzz`,
          amount: {
            currency_code: 'USD',
            value: (amount / constants.buzz.buzzDollarRatio).toFixed(2),
          },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
            brand_name: 'Civitai',
            locale: 'en-US',
            landing_page: 'LOGIN',
            shipping_preference: 'NO_SHIPPING',
            user_action: 'PAY_NOW',
          },
        },
      },
    }),
  });

  if (response.status === 200) {
    const data = (await response.json()) as { id: string };

    return {
      id: data.id,
    };
  } else {
    log({ message: 'Failed to create PayPal order', response: await response.text() });
    throw new Error('Failed to create PayPal order');
  }
};

export const processBuzzOrder = async (orderId: string) => {
  const response = await fetch(`${PAYPAL_URL}/v2/checkout/orders/${orderId}`, {
    headers: {
      Authorization,
    },
  });

  if (response.status === 200) {
    const data = (await response.json()) as {
      status: string;
      purchase_units: { reference_id: string }[];
    };

    if (data.status === 'APPROVED') {
      const referenceId = data.purchase_units[0].reference_id;
      const [userId, buzzAmount] = referenceId.split(':').map((x) => parseInt(x));

      // Give user the buzz assuming it hasn't been given
      const { transactionId } = await createBuzzTransaction({
        fromAccountId: 0,
        toAccountId: userId,
        amount: buzzAmount,
        type: TransactionType.Purchase,
        externalTransactionId: `PAYPAL_ORDER:${orderId}`,
        description: 'Buzz purchase',
        details: { paypalOrderId: orderId },
      });

      // Update order status
      await fetch(`${PAYPAL_URL}/v2/checkout/orders/${orderId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization,
        },
        body: JSON.stringify([
          {
            op: 'add',
            path: `/purchase_units/@reference_id=='${referenceId}'/custom_id`,
            value: transactionId,
          },
        ]),
      });

      return true;
    } else {
      log({
        message: 'Paypal order was not approved and buzz was attempted to be collected',
        response: await response.text(),
        orderId,
      });
      throw throwBadRequestError('Order not approved');
    }
  } else {
    log({
      orderId,
      message: 'Failed to process order. Buzz may not have been delivered.',
      response: await response.text(),
      externalTransactionId: `PAYPAL_ORDER:${orderId}`,
    });
    throw new Error('Failed to process PayPal order. Please contact support.');
  }
};
