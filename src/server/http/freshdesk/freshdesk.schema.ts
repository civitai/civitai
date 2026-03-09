import { z } from 'zod';

export const freshdeskWebhookPhaseSchema = z.enum(['kb-article', 'triage', 'investigation']);
export type FreshdeskWebhookPhase = z.infer<typeof freshdeskWebhookPhaseSchema>;

export const freshdeskWebhookPayloadSchema = z.object({
  ticket_id: z.coerce.number(),
  phase: freshdeskWebhookPhaseSchema,
  // Optional fields from Freshdesk placeholders
  subject: z.string().optional(),
  description_text: z.string().optional(),
  tags: z.string().optional(), // Comma-separated from Freshdesk
  triggered_event: z.string().optional(),
  cf_feature: z.string().optional(), // Custom field: feature area classification
});

export type FreshdeskWebhookPayload = z.infer<typeof freshdeskWebhookPayloadSchema>;
