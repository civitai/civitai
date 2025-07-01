import { z } from 'zod';

export namespace EmerchantPay {
  const baseMeta = z
    .object({
      internalOrderId: z.string(),
      userId: z.number().optional(),
      buzzAmount: z.number().optional(),
    })
    .passthrough();

  // WPF Create Payment Input Schema
  export type WPFCreatePaymentInputSchema = z.infer<typeof wpfCreatePaymentInputSchema>;
  export const wpfCreatePaymentInputSchema = z.object({
    transaction_id: z.string().min(1, 'Transaction ID is required'),
    usage: z.string().optional(),
    description: z.string().optional(),
    notification_url: z.string().url('Invalid notification URL').optional(),
    return_success_url: z.string().url('Invalid success URL'),
    return_failure_url: z.string().url('Invalid failure URL'),
    return_cancel_url: z.string().url('Invalid cancel URL').optional(),
    amount: z.number().positive('Amount must be positive'),
    currency: z.string().length(3, 'Currency must be 3 characters'),
    customer_email: z.string().email('Invalid email address'),
    customer_phone: z.string().optional(),
    lifetime: z.number().optional(), // in minutes
    billing_address: z
      .object({
        first_name: z.string().min(1, 'First name is required'),
        last_name: z.string().min(1, 'Last name is required'),
        address1: z.string().min(1, 'Address is required'),
        address2: z.string().optional(),
        zip_code: z.string().min(1, 'ZIP code is required'),
        city: z.string().min(1, 'City is required'),
        neighborhood: z.string().optional(),
        state: z.string().optional(),
        country: z.string().length(2, 'Country must be 2 characters'),
      })
      .optional(),
    transaction_types: z.array(
      z.object({
        name: z.enum(['authorize', 'authorize3d', 'sale', 'sale3d']),
        digital_asset_type: z.boolean().optional(),
      })
    ),
    metadata: baseMeta.optional(),
  });

  // WPF Create Payment Response Schema
  export type WPFCreatePaymentResponseSchema = z.infer<typeof wpfCreatePaymentResponseSchema>;
  export const wpfCreatePaymentResponseSchema = z.object({
    transaction_type: z.literal('wpf_create'),
    status: z.enum(['new', 'approved', 'declined', 'error', 'pending_async']),
    mode: z.enum(['test', 'live']),
    transaction_id: z.string(),
    unique_id: z.string(),
    redirect_url: z.string().url().optional(),
    technical_message: z.string().optional(),
    message: z.string().optional(),
    timestamp: z.string(),
    descriptor: z.string().optional(),
    amount: z.number(),
    currency: z.string(),
    consumer_id: z.string().optional(),
    sent_to_acquirer: z.boolean().optional(),
  });

  // WPF Reconcile Input Schema
  export type WPFReconcileInputSchema = z.infer<typeof wpfReconcileInputSchema>;
  export const wpfReconcileInputSchema = z.object({
    unique_id: z.string().min(1, 'Unique ID is required'),
  });

  // WPF Reconcile Response Schema
  export type WPFReconcileResponseSchema = z.infer<typeof wpfReconcileResponseSchema>;
  export const wpfReconcileResponseSchema = z.object({
    transaction_type: z.string(),
    status: z.enum(['new', 'approved', 'declined', 'error', 'pending_async', 'timeout']),
    mode: z.enum(['test', 'live']),
    transaction_id: z.string(),
    unique_id: z.string(),
    authorization_code: z.string().optional(),
    response_code: z.string().optional(),
    technical_message: z.string().optional(),
    message: z.string().optional(),
    timestamp: z.string(),
    descriptor: z.string().optional(),
    amount: z.number(),
    currency: z.string(),
    card_brand: z.string().optional(),
    card_number: z.string().optional(),
    card_type: z.string().optional(),
    card_holder: z.string().optional(),
    expiration_year: z.number().optional(),
    expiration_month: z.number().optional(),
    consumer_id: z.string().optional(),
    sent_to_acquirer: z.boolean().optional(),
  });

  // Webhook/Notification Schema
  export type WebhookNotificationSchema = z.infer<typeof webhookNotificationSchema>;
  export const webhookNotificationSchema = z.object({
    unique_id: z.string(),
    signature: z.string(),
    notification_type: z.string(),
    wpf_unique_id: z.string().optional(),
    payment_transaction: z.object({
      transaction_type: z.string(),
      status: z.string(),
      unique_id: z.string(),
      transaction_id: z.string(),
      amount: z.number(),
      currency: z.string(),
      authorization_code: z.string().optional(),
      response_code: z.string().optional(),
      technical_message: z.string().optional(),
      message: z.string().optional(),
      timestamp: z.string(),
      mode: z.enum(['test', 'live']),
    }),
  });

  // Error Response Schema
  export type ErrorResponseSchema = z.infer<typeof errorResponseSchema>;
  export const errorResponseSchema = z.object({
    transaction_type: z.string().optional(),
    status: z.literal('error'),
    mode: z.enum(['test', 'live']).optional(),
    transaction_id: z.string().optional(),
    unique_id: z.string().optional(),
    code: z.number().optional(),
    technical_message: z.string().optional(),
    message: z.string().optional(),
    timestamp: z.string().optional(),
  });
}
