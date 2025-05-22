import { z } from 'zod';

export namespace NOWPayments {
  export type CreatePaymentInvoiceInput = z.infer<typeof createPaymentInvoiceInputSchema>;
  export const createPaymentInvoiceInputSchema = z.object({
    price_amount: z.number(),
    price_currency: z.string(),
    order_id: z.string().nullish(),
    order_description: z.string().nullish(),
    ipn_callback_url: z.string().nullish(),
    success_url: z.string().nullish(),
    cancel_url: z.string().nullish(),
    is_fixed_rate: z.boolean().nullish(),
    is_fee_paid_by_user: z.boolean().nullish(),
  });

  export type CreatePaymentInvoiceResponse = z.infer<typeof createPaymentInvoiceResponseSchema>;
  export const createPaymentInvoiceResponseSchema = z.object({
    id: z.string(), // Invoice ID
    token_id: z.string(), // Internal identifier
    order_id: z.string(), // Order ID specified in request
    order_description: z.string(), // Order description specified in request
    price_amount: z.string(), // Base price in fiat
    price_currency: z.string(), // Ticker of base fiat currency
    pay_currency: z.string().nullish(), // Currency customer will pay with, or null if customer can choose
    ipn_callback_url: z.string().nullish(), // Link to your endpoint for IPN notifications
    invoice_url: z.string(), // Link to the payment page for the customer
    success_url: z.string().nullish(), // Redirect link after successful payment
    cancel_url: z.string().nullish(), // Redirect link if payment fails
    customer_email: z.string().nullish(), // Customer email, if provided
    partially_paid_url: z.string().nullish(), // Redirect link if payment gets partially paid status
    payout_currency: z.string().nullish(), // Ticker of payout currency
    created_at: z.string(), // Time of invoice creation
    updated_at: z.string(), // Time of latest invoice update
    is_fixed_rate: z.boolean(), // True if Fixed Rate option is enabled
    is_fee_paid_by_user: z.boolean(), // True if Fee Paid By User option is enabled
    source: z.string().nullish(), // Source of the payment, if provided
    collect_user_data: z.boolean(), // True if user data collection is enabled
  });

  export type CreatePaymentInput = z.infer<typeof createPaymentInputSchema>;
  export const createPaymentInputSchema = z.object({
    price_amount: z.number(),
    price_currency: z.string(),
    pay_amount: z.number().nullish(),
    pay_currency: z.string().nullish(),
    ipn_callback_url: z.string().nullish(),
    order_id: z.string().nullish(),
    order_description: z.string().nullish(),
    payout_address: z.string().nullish(),
    payout_currency: z.string().nullish(),
    payout_extra_id: z.string().nullish(),
    success_url: z.string().nullish(),
    cancel_url: z.string().nullish(),
    partially_paid_url: z.string().nullish(),
    is_fixed_rate: z.boolean().nullish(),
    is_fee_paid_by_user: z.boolean().nullish(),
  });

  export type CreatePaymentResponse = z.infer<typeof createPaymentResponseSchema>;
  export const createPaymentResponseSchema = z
    .object({
      payment_id: z.union([z.string(), z.number()]),
      invoice_id: z.union([z.string(), z.number()]).nullish(),
      payment_status: z.string(),
      pay_address: z.string(),
      price_amount: z.number(),
      price_currency: z.string(),
      pay_amount: z.number(),
      pay_currency: z.string(),
      order_id: z.string(),
      order_description: z.string(),
      ipn_callback_url: z.string().nullish(),
      created_at: z.string(),
      updated_at: z.string(),
      purchase_id: z.union([z.string(), z.number()]).nullish(),
      amount_received: z.number().nullish(),
      payin_extra_id: z.string().nullish(),
      smart_contract: z.string().nullish(),
      network: z.string().nullish(),
      network_precision: z.number().nullish(),
      time_limit: z.number().nullish(),
      burning_percent: z.union([z.number(), z.string()]).nullish(),
      expiration_estimate_date: z.string().nullish(),
    })
    .passthrough();

  // Estimate Price
  export type EstimatePriceInput = z.infer<typeof estimatePriceInputSchema>;
  export const estimatePriceInputSchema = z.object({
    amount: z.number(),
    currency_from: z.string().nullish(),
    currency_to: z.string().nullish(),
  });

  export type EstimatePriceResponse = z.infer<typeof estimatePriceResponseSchema>;
  export const estimatePriceResponseSchema = z.object({
    currency_from: z.string(),
    currency_to: z.string(),
    amount_from: z.number(),
    estimated_amount: z.union([z.number(), z.string()]),
  });

  // Minimum Payment Amount
  export type MinAmountInput = z.infer<typeof minAmountInputSchema>;
  export const minAmountInputSchema = z.object({
    currency_from: z.string(),
    currency_to: z.string(),
  });

  export type MinAmountResponse = z.infer<typeof minAmountResponseSchema>;
  export const minAmountResponseSchema = z.object({
    min_amount: z.number(),
  });

  // Exchange Rate
  export type ExchangeRateInput = z.infer<typeof exchangeRateInputSchema>;
  export const exchangeRateInputSchema = z.object({
    currency_from: z.string(),
    currency_to: z.string(),
  });

  export type ExchangeRateResponse = z.infer<typeof exchangeRateResponseSchema>;
  export const exchangeRateResponseSchema = z.object({
    currency_from: z.string(),
    currency_to: z.string(),
    rate: z.number(),
  });

  // Currencies
  export type CurrenciesResponse = z.infer<typeof currenciesResponseSchema>;
  export const currenciesResponseSchema = z.object({
    currencies: z.array(
      z.object({
        min_amount: z.number(),
        max_amount: z.number(),
        currency: z.string(),
      })
    ),
  });

  // Balance
  export type BalanceResponse = z.infer<typeof balanceResponseSchema>;
  export const balanceResponseSchema = z.array(
    z.object({
      currency: z.string(),
      balance: z.string(),
    })
  );

  // Payout Currencies
  export type PayoutCurrenciesResponse = z.infer<typeof payoutCurrenciesResponseSchema>;
  export const payoutCurrenciesResponseSchema = z.object({
    currencies: z.array(z.string()),
  });

  // Payments List
  export type PaymentsListResponse = z.infer<typeof paymentsListResponseSchema>;
  export const paymentsListResponseSchema = z.object({
    payments: z.array(z.lazy(() => createPaymentResponseSchema)),
  });

  export type WebhookEvent = z.infer<typeof webhookSchema>;
  export const webhookSchema = z.object({
    actually_paid: z.number().nullish(),
    actually_paid_at_fiat: z.number().nullish(),
    fee: z
      .object({
        currency: z.string(),
        depositFee: z.string(),
        serviceFee: z.string(),
        withdrawalFee: z.string(),
      })
      .nullish(),
    invoice_id: z.union([z.string(), z.number()]).nullish(),
    order_description: z.string().nullish(),
    order_id: z.string().nullish(),
    outcome_amount: z.number().nullish(),
    outcome_currency: z.string().nullish(),
    parent_payment_id: z.number().nullish(),
    pay_address: z.string().nullish(),
    pay_amount: z.number().nullish(),
    pay_currency: z.string().nullish(),
    payin_extra_id: z.string().nullish(),
    payment_extra_ids: z.any().nullish(),
    payment_id: z.number().nullish(),
    payment_status: z.string().nullish(),
    price_amount: z.number().nullish(),
    price_currency: z.string().nullish(),
    purchase_id: z.string().nullish(),
    updated_at: z.number().nullish(),
  });
}
