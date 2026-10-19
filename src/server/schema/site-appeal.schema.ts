import * as z from 'zod';
import { isHttpUrl } from '~/utils/url-helpers';
import { AppealCategory } from '~/shared/utils/prisma/enums';

export const SITE_APPEAL_MESSAGE_MIN = 20;
export const SITE_APPEAL_MESSAGE_MAX = 2000;
export const SITE_APPEAL_SUBJECT_MAX = 200;
export const SITE_APPEAL_LINK_MAX = 500;

const message = z
  .string()
  .trim()
  .min(
    SITE_APPEAL_MESSAGE_MIN,
    `Tell us a little more (at least ${SITE_APPEAL_MESSAGE_MIN} characters)`
  )
  .max(SITE_APPEAL_MESSAGE_MAX);

const link = z
  .string()
  .trim()
  .max(SITE_APPEAL_LINK_MAX)
  .refine(isHttpUrl, 'Enter a full link, starting with https://');

export type SubmitSiteAppealInput = z.output<typeof submitSiteAppealSchema>;
export const submitSiteAppealSchema = z.discriminatedUnion('category', [
  z.object({ category: z.literal(AppealCategory.Account), message }),
  z.object({
    category: z.literal(AppealCategory.Article),
    entityId: z.number().int().positive(),
    message,
  }),
  z.object({
    category: z.literal(AppealCategory.Model),
    entityId: z.number().int().positive(),
    message,
  }),
  z.object({
    category: z.literal(AppealCategory.Other),
    subject: z.string().trim().min(3).max(SITE_APPEAL_SUBJECT_MAX),
    // An empty field arrives as '' from the form; it means no link.
    link: z.union([link, z.literal('').transform(() => undefined)]).optional(),
    message,
  }),
]);

export type { SiteAppealContext } from '@civitai/shared/site-appeal';
