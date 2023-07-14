import { z } from 'zod';

export type GetLatestAnnouncementInput = z.infer<typeof getLastestSchema>;
export const getLastestSchema = z.object({
  dismissed: z.array(z.number()).optional(),
});

export type GetAnnouncementsInput = z.infer<typeof getAnnouncementsSchema>;
export const getAnnouncementsSchema = z.object({
  dismissed: z.array(z.number()).optional(),
  ids: z.array(z.number()).optional(),
});
