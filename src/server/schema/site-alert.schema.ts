import * as z from 'zod';
import {
  SITE_ALERT_MAX_DURATION_MS,
  siteAlertSeverities,
  siteAlertSurfaces,
} from '~/shared/constants/site-alert.constants';
import { DomainColor } from '~/shared/utils/prisma/enums';
import { isValidAlertPathPattern } from '~/shared/utils/site-alert-match';

const pathPatternSchema = z.string().trim().max(200).refine(isValidAlertPathPattern, {
  message: 'Use an absolute path; * matches one segment, ** any number. No other wildcards.',
});

const fields = {
  severity: z.enum(siteAlertSeverities),
  title: z.string().trim().min(1).max(120),
  message: z.string().trim().max(500).nullish(),
  paths: z.array(pathPatternSchema).max(20),
  surfaces: z.array(z.enum(siteAlertSurfaces)).min(1),
  domains: z.array(z.enum(DomainColor)).min(1),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  dismissible: z.boolean(),
};

/** The window rule every write must satisfy, checked on the stored result rather than the input. */
export function siteAlertWindowError({ startsAt, endsAt }: { startsAt: Date; endsAt: Date }) {
  const from = Math.max(startsAt.getTime(), Date.now());
  if (endsAt.getTime() <= startsAt.getTime()) return 'endsAt must be after startsAt';
  if (endsAt.getTime() - from > SITE_ALERT_MAX_DURATION_MS)
    return 'An alert can run for at most 7 days';
  return null;
}

export const postSiteAlertSchema = z
  .object({
    ...fields,
    paths: fields.paths.default([]),
    surfaces: fields.surfaces.default(['everywhere']),
    domains: fields.domains.default(['all']),
    startsAt: fields.startsAt.optional(),
    dismissible: fields.dismissible.optional(),
  })
  .superRefine((input, ctx) => {
    const error = siteAlertWindowError({
      startsAt: input.startsAt ?? new Date(),
      endsAt: input.endsAt,
    });
    if (error) ctx.addIssue({ code: 'custom', path: ['endsAt'], message: error });
  });
export type PostSiteAlertInput = z.infer<typeof postSiteAlertSchema>;

export const editSiteAlertSchema = z
  .object({ id: z.number().int().positive() })
  .extend(z.object(fields).partial().shape);
export type EditSiteAlertInput = z.infer<typeof editSiteAlertSchema>;

export const extendSiteAlertSchema = z.object({
  id: z.number().int().positive(),
  minutes: z
    .number()
    .int()
    .min(1)
    .max(SITE_ALERT_MAX_DURATION_MS / 60_000),
});
export type ExtendSiteAlertInput = z.infer<typeof extendSiteAlertSchema>;

export const siteAlertIdSchema = z.object({ id: z.number().int().positive() });

// `v` only varies the URL so a new version misses the browser and edge caches; the server ignores it.
export const getActiveSiteAlertsSchema = z.object({ v: z.number().int().nonnegative().optional() });
