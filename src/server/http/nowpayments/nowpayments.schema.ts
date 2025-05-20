import { z } from 'zod';

export namespace NOWPayments {
  export type CreatePaymentInvoiceInput = z.infer<typeof createPaymentInvoiceInputSchema>;
  export const createPaymentInvoiceInputSchema = z.object({
    price_amount: z.number(),
    price_currency: z.string(),
    order_id: z.string(),
    order_description: z.string(),
    ipn_callback_url: z.string(),
    success_url: z.string(),
    cancel_url: z.string(),
  });

  export type CreatePaymentInvoiceResponse = z.infer<typeof createPaymentInvoiceResponseSchema>;
  export const createPaymentInvoiceResponseSchema = z.object({
    payment_id: z.string(),
    payment_status: z.string(),
    pay_address: z.string(),
    price_amount: z.number(),
    price_currency: z.string(),
    pay_amount: z.number(),
    pay_currency: z.string(),
    order_id: z.string(),
    order_description: z.string(),
    ipn_callback_url: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    purchase_id: z.string(),
    amount_received: z.number().nullable(),
    payin_extra_id: z.string().nullable(),
    smart_contract: z.string(),
    network: z.string(),
    network_precision: z.number(),
    time_limit: z.number().nullable(),
    burning_percent: z.number().nullable(),
    expiration_estimate_date: z.string(),
  });

  export type CreatePaymentInput = z.infer<typeof createPaymentInputSchema>;
  export const createPaymentInputSchema = z.object({
    price_amount: z.number(),
    price_currency: z.string(),
    pay_amount: z.number().optional(),
    pay_currency: z.string().optional(),
    ipn_callback_url: z.string().optional(),
    order_id: z.string().optional(),
    order_description: z.string().optional(),
    payout_address: z.string().optional(),
    payout_currency: z.string().optional(),
    payout_extra_id: z.string().optional(),
    success_url: z.string().optional(),
    cancel_url: z.string().optional(),
    partially_paid_url: z.string().optional(),
    is_fixed_rate: z.boolean().optional(),
    is_fee_paid_by_user: z.boolean().optional(),
  });

  export type CreatePaymentResponse = z.infer<typeof createPaymentResponseSchema>;
  export const createPaymentResponseSchema = z.object({
    payment_id: z.string(),
    payment_status: z.string(),
    pay_address: z.string(),
    price_amount: z.number(),
    price_currency: z.string(),
    pay_amount: z.number(),
    pay_currency: z.string(),
    order_id: z.string(),
    order_description: z.string(),
    ipn_callback_url: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    purchase_id: z.string(),
    amount_received: z.number().nullable(),
    payin_extra_id: z.string().nullable(),
    smart_contract: z.string(),
    network: z.string(),
    network_precision: z.number(),
    time_limit: z.number().nullable(),
    burning_percent: z.number().nullable(),
    expiration_estimate_date: z.string(),
  });

  // Estimate Price
  export type EstimatePriceInput = z.infer<typeof estimatePriceInputSchema>;
  export const estimatePriceInputSchema = z.object({
    amount: z.number(),
    currency_from: z.string().optional(),
    currency_to: z.string().optional(),
  });

  export type EstimatePriceResponse = z.infer<typeof estimatePriceResponseSchema>;
  export const estimatePriceResponseSchema = z.object({
    currency_from: z.string(),
    currency_to: z.string(),
    amount_from: z.number(),
    estimated_amount: z.number(),
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
}
