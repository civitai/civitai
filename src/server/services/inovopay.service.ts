import { env } from 'process';
import { logToAxiom } from '../logging/client';
import nowpaymentsCaller from '~/server/http/nowpayments/nowpayments.caller';
import Decimal from 'decimal.js';
import { NOW_PAYMENTS_FIXED_FEE } from '~/server/common/constants';
import { TransactionCreateInput } from '~/server/schema/inovopay.schema';
import { InovoPay } from '~/server/http/inovopay/inovopay.schema';
import inovopayCaller from '~/server/http/inovopay/inovopay.caller';

const log = async (data: MixedObject) => {
  await logToAxiom({ name: 'inovopay-service', type: 'error', ...data }).catch();
};

export const createBuzzOrder = async (input: TransactionCreateInput & { userId: number }) => {
  try {
    const data: InovoPay.CreditCardTransactionInput = {
      CUST_FNAME: input.firstName ?? undefined,
      CUST_LNAME: input.lastName ?? undefined,
      CUST_EMAIL: input.email ?? undefined,
      BILL_ADDR: input.billingAddress ?? undefined,
      BILL_ADDR_CITY: input.billingCity ?? undefined,
      BILL_ADDR_STATE: input.billingState ?? undefined,
      BILL_ADDR_ZIP: input.billingZip ?? undefined,
      BILL_ADDR_COUNTRY: input.billingCountry ?? undefined,
      PMT_NUMB: input.cardNumber,
      TOKEN_GUID: input.tokenGuid ?? undefined,
      PMT_KEY: input.cardKey,
      PMT_EXPIRY: input.cardExpiry,
      LI_COUNT_1: 1,
      LI_PROD_ID_1: 1,
      LI_VALUE_1: new Decimal(input.unitAmount + NOW_PAYMENTS_FIXED_FEE).dividedBy(100).toNumber(), // Inovopay use actual amount. Not multiplied by 100
      XTL_ORDER_ID: `${input.userId}-${input.buzzAmount}-${new Date().getTime()}`,
      REQUEST_CURRENCY: 'USD', // Assuming USD as the currency. We don't support anything else for buzz.
      TRANS_REBILL_TYPE: 'NONE', // Assuming no rebill for buzz transactions
      CARD_ON_FILE_FLAG: '0', // Assuming this is a one-time transaction
      // ...add other required fields for the transaction here
    };

    const response = await inovopayCaller.createCreditCardTransaction(data);
    return response;
  } catch (error) {
    await log({
      message: 'Failed to create buzz order',
      error,
      input,
    });
    throw new Error('Failed to create buzz order');
  }
};
