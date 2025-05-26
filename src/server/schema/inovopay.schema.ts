import { z } from 'zod';
import { constants } from '~/server/common/constants';

export const inovoPayCreditCardHolderDetails = z.object({
  firstName: z.string().nullish(), // CUST_FNAME
  lastName: z.string().nullish(), // CUST_LNAME
  email: z.string().nullish(), // CUST_EMAIL
  billingAddress: z.string().nullish(), // BILL_ADDR
  billingCity: z.string().nullish(), // BILL_ADDR_CITY
  billingState: z.string().nullish(), // BILL_ADDR_STATE
  billingZip: z.string().nullish(), // BILL_ADDR_ZIP
  billingCountry: z.string().nullish(), // BILL_ADDR_COUNTRY
  cardNumber: z.string(), // PMT_NUMB
  tokenGuid: z.string().nullish(), // TOKEN_GUID
  cardKey: z.string(), // PMT_KEY
  cardExpiry: z.string(), // PMT_EXPIRY
});

export type InovoPayCreditCardHolderDetails = z.infer<typeof inovoPayCreditCardHolderDetails>;

export type TransactionCreateInput = z.infer<typeof buzzTransactionCreate>;
export const buzzTransactionCreate = inovoPayCreditCardHolderDetails.extend({
  unitAmount: z.number().min(constants.buzz.minChargeAmount).max(constants.buzz.maxChargeAmount), // LI_VALUE_1
  buzzAmount: z.number(),
  currency: z.string().default('USD'), // REQUEST_CURRENCY
});
