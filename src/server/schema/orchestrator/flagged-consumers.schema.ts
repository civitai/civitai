import z from 'zod';

export const getFlaggedConsumersSchema = z.object({
  startDate: z.date().optional(),
  reason: z.string().optional(),
});

export const getFlaggedConsumerStrikesSchema = z.object({ consumerId: z.string() });

export const getFlaggedReasonsSchema = z.object({
  startDate: z.date().optional(),
});
