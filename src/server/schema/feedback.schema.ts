import * as z from 'zod';
import { FEEDBACK_AREAS, FEEDBACK_MESSAGE_MAX_LENGTH } from '~/shared/constants/feedback.constants';

export const feedbackAreaSchema = z.enum(FEEDBACK_AREAS);

// Everything here is client-supplied and therefore a claim, not evidence — the
// submit request cannot re-derive which backend served the page the user was
// looking at. Stored to make a one-line report actionable, never read as proof.
const feedbackContextSchema = z.object({
  path: z.string().max(300).optional(),
  reportedSource: z.string().max(50).optional(),
  reportedPageSources: z.string().max(200).optional(),
  pagesLoaded: z.number().int().min(0).max(10_000).optional(),
  filters: z
    .record(z.string().max(50), z.union([z.string().max(200), z.number(), z.boolean()]))
    .refine((val) => Object.keys(val).length <= 20, 'Too many filter keys')
    .optional(),
});

export type CreateFeedbackInput = z.infer<typeof createFeedbackSchema>;
export const createFeedbackSchema = z.object({
  area: feedbackAreaSchema,
  message: z.string().trim().min(1).max(FEEDBACK_MESSAGE_MAX_LENGTH),
  context: feedbackContextSchema.optional(),
});

export type GetFeedbackAreaInput = z.infer<typeof getFeedbackAreaSchema>;
export const getFeedbackAreaSchema = z.object({ area: feedbackAreaSchema });
