import { env } from 'process';
import { logToAxiom } from '../logging/client';
import Decimal from 'decimal.js';
import { CreateBuzzCharge } from '~/server/schema/coinbase.schema';
import { COINBASE_FIXED_FEE } from '~/server/common/constants';
import coinbaseCaller from '~/server/http/coinbase/coinbase.caller';

const log = async (data: MixedObject) => {
  await logToAxiom({ name: 'coinbase-service', type: 'error', ...data }).catch();
};

export const createBuzzOrder = async (input: CreateBuzzCharge & { userId: number }) => {
  const successUrl =
    `${env.NEXTAUTH_URL}/payment/nowpayments?` +
    new URLSearchParams([['buzzAmount', input.buzzAmount.toString()]]);

  const orderId = `${input.userId}-${input.buzzAmount}-${new Date().getTime()}`;

  const charge = await coinbaseCaller.createCharge({
    name: `Buzz purchase`,
    description: `Buzz purchase for ${input.buzzAmount} BUZZ`,
    pricing_type: 'fixed_price',
    local_price: {
      amount: new Decimal(input.unitAmount + COINBASE_FIXED_FEE).dividedBy(100).toString(), // Nowpayments use actual amount. Not multiplied by 100
      currency: 'USD',
    },
    metadata: {
      buzzAmount: input.buzzAmount,
      internalOrderId: orderId,
    },
    redirect_url: successUrl,
    cancel_url: env.NEXTAUTH_URL,
  });

  if (!charge) {
    throw new Error('Failed to create charge');
  }

  return charge;
};

export const processBuzzOrder = async () => {
  // TODO.
};
