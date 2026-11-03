import * as z from 'zod';

/** The most free days one extension gives. */
export const MEMBERSHIP_EXTEND_MAX_DAYS = 31;

const userId = z.number().int().positive();
const days = z.number().int().min(1).max(MEMBERSHIP_EXTEND_MAX_DAYS);

export const previewMembershipExtensionSchema = z.object({ userId, days });

export const extendMembershipSchema = z.object({
  userId,
  days,
  reason: z.string().trim().min(10).max(500),
  // current_period_end (epoch seconds) from the preview: a different live value refuses.
  expectedCurrentPeriodEnd: z.number().int().positive(),
});

export type ExtendMembershipInput = z.infer<typeof extendMembershipSchema>;
