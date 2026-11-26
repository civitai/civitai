import * as z from 'zod';
import { constants } from '~/server/common/constants';
import {
  FEATURE_PAGES_MINE_MAX_REQUESTS,
  FEATURE_PAGES_TEXT_MAX_LENGTH,
  featurePageCommentUrnRegex,
  featurePageRequestUrnRegex,
  featurePageSubjectUrnRegex,
} from '~/shared/constants/feature-pages.constants';
import { ReportReason } from '~/shared/utils/prisma/enums';

const requestUrn = z.string().regex(featurePageRequestUrnRegex);

export const featurePageVoteSchema = z.object({
  request: requestUrn,
  value: z.union([z.literal(0), z.literal(1)]),
});
export type FeaturePageVoteInput = z.infer<typeof featurePageVoteSchema>;

export const featurePageMineSchema = z.object({
  requests: z.array(requestUrn).min(1).max(FEATURE_PAGES_MINE_MAX_REQUESTS),
});
export type FeaturePageMineInput = z.infer<typeof featurePageMineSchema>;

const requestId = z.string().min(1).max(128);
const commentUrn = z.string().regex(featurePageCommentUrnRegex);
// Plain text, no longer than the platform takes; the site's own limit is checked on the stored HTML.
const commentText = z
  .string()
  .trim()
  .min(1)
  .max(Math.min(FEATURE_PAGES_TEXT_MAX_LENGTH, constants.comments.maxLength));

export const featurePageCommentSchema = z.object({
  requestId,
  subject: z.string().regex(featurePageSubjectUrnRegex),
  parent: commentUrn.optional(),
  text: commentText,
});
export type FeaturePageCommentInput = z.infer<typeof featurePageCommentSchema>;

export const featurePageCommentEditSchema = z.object({
  requestId,
  comment: commentUrn,
  text: commentText,
});
export type FeaturePageCommentEditInput = z.infer<typeof featurePageCommentEditSchema>;

export const featurePageCommentRetractSchema = z.object({ requestId, comment: commentUrn });
export type FeaturePageCommentRetractInput = z.infer<typeof featurePageCommentRetractSchema>;

export const featurePageCommentReportSchema = z.object({
  comment: commentUrn,
  reason: z.enum([ReportReason.TOSViolation, ReportReason.Spam, ReportReason.AdminAttention]),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type FeaturePageCommentReportInput = z.infer<typeof featurePageCommentReportSchema>;
