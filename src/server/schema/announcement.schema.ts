import { z } from 'zod';

export type GetLatestAnnouncementInput = z.infer<typeof getLastestSchema>;
export const getLastestSchema = z.object({
  dismissed: z.array(z.number()).optional(),
});
