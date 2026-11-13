import { z } from 'zod';
import { int4Id } from './query';

const MISSING = 'Enter the date the user asked.';

/**
 * Queueing an export from the dashboard, where there is no ticket: the moderator enters the date the
 * user asked, which starts the response deadline. Required, and not in the future.
 */
export const dashboardQueueSchema = z.object({
  userId: int4Id,
  requestedAt: z
    .string({ error: MISSING })
    .regex(/^\d{4}-\d{2}-\d{2}$/, MISSING)
    .transform((s) => new Date(`${s}T00:00:00Z`))
    .refine((d) => !Number.isNaN(d.getTime()), MISSING)
    .refine((d) => d.getTime() <= Date.now(), 'The request date cannot be in the future.'),
});
