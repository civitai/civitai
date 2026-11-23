import * as z from 'zod';
import {
  FEATURE_PAGES_MINE_MAX_REQUESTS,
  featurePageRequestUrnRegex,
} from '~/shared/constants/feature-pages.constants';

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
