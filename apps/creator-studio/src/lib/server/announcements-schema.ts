import { z } from 'zod';
// Relative, not `$lib`: this module is unit-tested by the app's node vitest project, which has no
// SvelteKit plugin and cannot resolve the alias — an aliased import fails COLLECTION, which reads as
// zero tests rather than as a failure.
import { checkbox } from './monetization/form-fields';
import { CONTENT_MAX, DOMAIN_COLORS, LINK_TEXT_MAX, TITLE_MAX } from '../announcements';

const optionalText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().trim().max(max).optional()
  );

const optionalNumber = z.preprocess(
  (v) => (v === '' || v == null ? undefined : Number(v)),
  z.number().finite().optional()
);

// `datetime-local` gives a local wall-clock string; an empty box clears the date.
const optionalDate = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() !== '' ? new Date(v) : null),
  z.date().nullable()
);

// One comma-joined field rather than repeated inputs: the action parses with `Object.fromEntries`,
// which keeps only the LAST value of a repeated key, so checkboxes would silently post one domain.
const domainList = z.preprocess(
  (v) =>
    typeof v === 'string'
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : v,
  z.array(z.enum(DOMAIN_COLORS)).nonempty('Choose at least one domain')
);

export const announcementFormSchema = z
  .object({
    id: z.preprocess(
      (v) => (v === '' || v == null ? undefined : Number(v)),
      z.number().int().positive().optional()
    ),
    title: z.string().trim().min(1, 'Add a subject').max(TITLE_MAX),
    content: z.string().trim().min(1, 'Add a message').max(CONTENT_MAX),
    domain: domainList,
    profileOnly: checkbox,
    startsAt: optionalDate,
    endsAt: optionalDate,
    linkUrl: optionalText(2048),
    linkText: optionalText(LINK_TEXT_MAX),
    // The object key minted by the main app's upload endpoint. It becomes an `Image` row on the
    // server (resolveCoverImageId); this side never creates one, and the key is a UUID because
    // that endpoint mints it with randomUUID.
    coverKey: z.preprocess((v) => (v === '' || v == null ? undefined : v), z.uuid().optional()),
    coverWidth: optionalNumber,
    coverHeight: optionalNumber,
    coverMimeType: optionalText(100),
    coverSizeKB: optionalNumber,
  })
  .refine((v) => !v.linkUrl || /^https?:\/\//i.test(v.linkUrl), {
    message: 'Button link must start with http:// or https://',
    path: ['linkUrl'],
  })
  .refine((v) => !!v.linkUrl === !!v.linkText, {
    message: 'A button needs both a link and button text',
    path: ['linkText'],
  })
  .refine((v) => !v.startsAt || !v.endsAt || v.endsAt > v.startsAt, {
    message: 'End date must be after the start date',
    path: ['endsAt'],
  });

export type AnnouncementForm = z.infer<typeof announcementFormSchema>;

export const deleteAnnouncementSchema = z.object({
  id: z.preprocess((v) => Number(v), z.number().int().positive()),
});

// The allowance is JSON off another service, and its numbers are not guaranteed: a creator with no
// score row serialises as `null` (NaN does too), which crashed the notice on `toLocaleString`.
// Parsing here keeps every screen downstream working with plain numbers.
export const count = z
  .number()
  .nullish()
  .transform((v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0));

export const allowanceSchema = z.object({
  eligible: z.boolean(),
  tier: z.string(),
  score: count,
  minScore: count,
  used: count,
  limit: count,
  windowDays: count,
  nextAvailableAt: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
});

export type AnnouncementAllowancePayload = z.infer<typeof allowanceSchema>;
