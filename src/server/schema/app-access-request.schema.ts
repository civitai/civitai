import * as z from 'zod';
import {
  APP_ACCESS_LINKS_MAX,
  APP_ACCESS_REQUEST_DECISIONS,
  APP_ACCESS_REQUEST_STATUSES,
  APP_ACCESS_WHAT_TO_BUILD_MAX,
  APP_ACCESS_WHAT_TO_BUILD_MIN,
  isAccessRequestLink,
  splitAccessRequestLinks,
} from '~/shared/constants/app-access-request.constants';

// A NUL or an unpaired surrogate: Postgres stores neither in `text`, so one would fail the write as
// a 500 instead of a validation error.
const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
export const APP_ACCESS_UNSTORABLE_MESSAGE = 'Contains a character that cannot be stored.';

export const APP_ACCESS_WHAT_TO_BUILD_TOO_SHORT = `Tell us a bit more — at least ${APP_ACCESS_WHAT_TO_BUILD_MIN} characters.`;
export const APP_ACCESS_WHAT_TO_BUILD_TOO_LONG = `Keep it under ${APP_ACCESS_WHAT_TO_BUILD_MAX} characters.`;
export const APP_ACCESS_LINK_INVALID = 'Links must be full http(s) URLs, one per line.';
export const APP_ACCESS_TOO_MANY_LINKS = `Add at most ${APP_ACCESS_LINKS_MAX} links.`;

const whatToBuild = z
  .string()
  .trim()
  .min(APP_ACCESS_WHAT_TO_BUILD_MIN, APP_ACCESS_WHAT_TO_BUILD_TOO_SHORT)
  .max(APP_ACCESS_WHAT_TO_BUILD_MAX, APP_ACCESS_WHAT_TO_BUILD_TOO_LONG)
  .refine((value) => !UNSTORABLE.test(value), APP_ACCESS_UNSTORABLE_MESSAGE);

/** What `appAccessRequest.submit` takes. */
export const submitAppAccessRequestSchema = z.object({
  whatToBuild,
  links: z
    .array(z.string().trim().refine(isAccessRequestLink, APP_ACCESS_LINK_INVALID))
    .max(APP_ACCESS_LINKS_MAX, APP_ACCESS_TOO_MANY_LINKS)
    .default([]),
});
export type SubmitAppAccessRequestInput = z.infer<typeof submitAppAccessRequestSchema>;

/**
 * The modal's form: the same bounds, with links typed one per line. `toSubmitInput` turns a valid
 * form value into the mutation's input.
 */
export const appAccessRequestFormSchema = z.object({
  whatToBuild,
  links: z
    .string()
    .refine(
      (text) => splitAccessRequestLinks(text).length <= APP_ACCESS_LINKS_MAX,
      APP_ACCESS_TOO_MANY_LINKS
    )
    .refine(
      (text) => splitAccessRequestLinks(text).every(isAccessRequestLink),
      APP_ACCESS_LINK_INVALID
    ),
});
export type AppAccessRequestFormValues = z.infer<typeof appAccessRequestFormSchema>;

export function toSubmitInput(values: AppAccessRequestFormValues): SubmitAppAccessRequestInput {
  return { whatToBuild: values.whatToBuild, links: splitAccessRequestLinks(values.links) };
}

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
