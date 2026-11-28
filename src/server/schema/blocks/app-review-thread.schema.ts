import * as z from 'zod';
import { REVIEW_MESSAGE_BODY_MAX, REVIEW_MESSAGE_BODY_MIN } from '~/shared/utils/app-review-thread';

/**
 * The reply thread on an app review decision. The subject is a request id (`pubreq_…` or
 * `alpr_…`); the service resolves it and decides whether the caller may see it. Who a message
 * goes to is derived by the service, never supplied.
 */

export const reviewThreadSubjectSchema = z.object({
  subjectId: z.string().min(1).max(64),
});
export type ReviewThreadSubjectInput = z.infer<typeof reviewThreadSubjectSchema>;

export const postReviewMessageSchema = z.object({
  subjectId: z.string().min(1).max(64),
  // Trimmed first, so a body of spaces is refused here rather than stored empty.
  body: z.string().trim().min(REVIEW_MESSAGE_BODY_MIN).max(REVIEW_MESSAGE_BODY_MAX),
});
export type PostReviewMessageInput = z.infer<typeof postReviewMessageSchema>;
