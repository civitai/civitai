import * as z from 'zod';
import {
  APP_ACCESS_REQUEST_DECISIONS,
  APP_ACCESS_REQUEST_STATUSES,
  APP_ACCESS_WHAT_TO_BUILD_MAX,
} from '~/shared/constants/app-access-request.constants';

export const APP_ACCESS_WHAT_TO_BUILD_TOO_LONG = `Keep it under ${APP_ACCESS_WHAT_TO_BUILD_MAX} characters.`;

/**
 * What `appAccessRequest.submit` takes, and the panel's form. Links go in the same free text.
 * `whatToBuild` is OPTIONAL: an empty or missing answer is stored as `''`, so a request is one
 * click. Whatever a person does write still reaches the moderator queue.
 */
export const submitAppAccessRequestSchema = z.object({
  whatToBuild: z
    .string()
    .trim()
    .max(APP_ACCESS_WHAT_TO_BUILD_MAX, APP_ACCESS_WHAT_TO_BUILD_TOO_LONG)
    .default(''),
});
export type SubmitAppAccessRequestInput = z.infer<typeof submitAppAccessRequestSchema>;

export const APP_ACCESS_LIST_LIMIT_MAX = 100;

export const listAppAccessRequestsSchema = z.object({
  status: z.enum(APP_ACCESS_REQUEST_STATUSES).optional(),
  /** The last row id of the previous page; rows come newest first. */
  cursor: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(APP_ACCESS_LIST_LIMIT_MAX).default(50),
});
export type ListAppAccessRequestsInput = z.infer<typeof listAppAccessRequestsSchema>;

export const decideAppAccessRequestSchema = z.object({
  id: z.number().int().positive(),
  decision: z.enum(APP_ACCESS_REQUEST_DECISIONS),
});
export type DecideAppAccessRequestInput = z.infer<typeof decideAppAccessRequestSchema>;
