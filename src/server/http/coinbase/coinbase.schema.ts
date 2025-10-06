import * as z from 'zod';

export namespace Coinbase {
  const baseMeta = z
    .object({
      internalOrderId: z.string(),
      userId: z.number().optional(),
      buzzAmount: z.number().optional(),
    })
    .passthrough();

  export type CreateChargeInputSchema = z.infer<typeof createChargeInputSchema>;
  export const createChargeInputSchema = z.object({
    name: z.string().min(1, 'Name is required'),
    description: z.string().optional(),
    pricing_type: z.enum(['fixed_price', 'no_price']),
    local_price: z.object({
      amount: z.string().min(1, 'Amount is required'),
      currency: z.string().min(1, 'Currency is required'),
    }),
    metadata: baseMeta.optional(),
    redirect_url: z.url('Invalid URL').optional(),
    cancel_url: z.url('Invalid URL').optional(),
  });

  export type CreateChargeResponseSchema = z.infer<typeof createChargeResponseSchema>;
  export const createChargeResponseSchema = z.object({
    brand_color: z.string(),
    brand_logo_url: z.string(),
    charge_kind: z.string(),
    checkout: z.object({
      id: z.string(),
    }),
    code: z.string(),
    confirmed_at: z.string(),
    created_at: z.string(),
    description: z.string(),
    expires_at: z.string(),
    hosted_url: z.string(),
    id: z.string(),
    name: z.string(),
    organization_name: z.string(),
    metadata: baseMeta.optional(),
    pricing: z.object({
      local: z.object({
        amount: z.string(),
        currency: z.string(),
      }),
      settlement: z.object({
        amount: z.string(),
        currency: z.string(),
      }),
    }),
    pricing_type: z.string(),
    redirects: z.object({
      cancel_url: z.string(),
      success_url: z.string(),
      will_redirect_after_success: z.boolean(),
    }),
    support_email: z.string(),
    third_party_provider: z.string(),
    timeline: z.array(
      z.object({
        status: z.string(),
        time: z.string(),
      })
    ),
    web3_data: z.object({
      failure_events: z.array(
        z.object({
          input_token_address: z.string(),
          network_fee_paid: z.string(),
          reason: z.string(),
          sender: z.string(),
          timestamp: z.string(),
          tx_hsh: z.string(),
        })
      ),
      success_events: z.array(
        z.object({
          finalized: z.boolean(),
          input_token_address: z.string(),
          input_token_amount: z.string(),
          network_fee_paid: z.string(),
          recipient: z.string(),
          sender: z.string(),
          timestamp: z.string(),
          tx_hsh: z.string(),
        })
      ),
      transfer_intent: z.object({
        call_data: z.object({
          deadline: z.string(),
          fee_amount: z.string(),
          id: z.string(),
          operator: z.string(),
          prefix: z.string(),
          recipient: z.string(),
          recipient_amount: z.string(),
          recipient_currency: z.string(),
          refund_destination: z.string(),
          signature: z.string(),
        }),
        metadata: z.object({
          chain_id: z.number(),
          contract_address: z.string(),
          sender: z.string(),
        }),
      }),
      contract_address: z.string(),
      contract_addresses: z.null(),
    }),
  });

  export type WebhookEventSchema = z.infer<typeof webhookEventSchema>;
  export const webhookEventSchema = z.object({
    attempt_number: z.number(),
    event: z.object({
      api_version: z.string(),
      created_at: z.string(),
      data: createChargeResponseSchema,
      id: z.string(),
      resource: z.string(),
      type: z.string(),
    }),
    id: z.string(),
    scheduled_for: z.string(),
  });
}
