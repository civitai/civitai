import * as z from 'zod';

import { APP_SUB_LISTING_REASON_MAX } from '~/shared/constants/app-sub-listing.constants';

/** Moderator inputs for the `/apps/review` Sub-listings tab. Kept out of the service so the
 *  router can validate without loading it. */

export const SUB_LISTING_MOD_ACTIONS = [
  'approve',
  'hide',
  'restore',
  'approve-edit',
  'reject-edit',
] as const;
export type SubListingModAction = (typeof SUB_LISTING_MOD_ACTIONS)[number];

export const moderateSubListingSchema = z.object({
  id: z.string().min(1).max(64),
  action: z.enum(SUB_LISTING_MOD_ACTIONS),
  reason: z.string().trim().max(APP_SUB_LISTING_REASON_MAX).optional(),
  version: z.string().datetime(),
});
export type ModerateSubListingInput = z.infer<typeof moderateSubListingSchema>;

export const listSubListingQueueSchema = z.object({
  view: z.enum(['queue', 'approved', 'hidden']).default('queue'),
  cursor: z.string().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(50).default(25),
});
export type ListSubListingQueueInput = z.infer<typeof listSubListingQueueSchema>;
