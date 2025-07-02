import * as z from 'zod/v4';

export const getTipaltiDashbordUrlSchema = z.object({
  type: z.enum(['setup', 'paymentHistory']).default('setup'),
});
export type GetTipaltiDashbordUrlSchema = z.infer<typeof getTipaltiDashbordUrlSchema>;
