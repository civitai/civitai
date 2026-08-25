import { z } from 'zod';
// Relative, not `$lib`: this module is unit-tested by the app's node vitest project, which has no
// SvelteKit plugin and cannot resolve the alias — an aliased import fails COLLECTION, which reads as
// zero tests rather than as a failure.
import { checkbox, numberish } from './form-fields';
import { CONTENT_MAX, DOMAIN_COLORS, LINK_TEXT_MAX, TITLE_MAX } from '../announcements';

const optionalText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().trim().max(max).optional()
  );

const optionalNumber = z.preprocess(numberish, z.number().finite().optional());

// The composer converts the picker's wall-clock value to an ISO instant in the creator's own
// browser, so what arrives here is zoned and unambiguous. An empty value clears the date.
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
    id: z.preprocess(numberish, z.number().int().positive().optional()),
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
  // A path resolves on whichever site the reader is on, which is the point. `//host` is
  // protocol-relative and leaves the site despite looking like a path, so it is not one.
  .refine((v) => !v.linkUrl || /^https?:\/\//i.test(v.linkUrl) || /^\/(?!\/)/.test(v.linkUrl), {
    message: 'Button link must be a full https:// URL or a path like /models/123',
    path: ['linkUrl'],
  })
  .refine((v) => !!v.linkUrl === !!v.linkText, {
    message: 'A button needs both a link and button text',
    path: ['linkText'],
  });
// No start/end ordering refine: the main app slides the end forward (clampAnnouncementWindow);
// rejecting here means the clamp never runs.

export type AnnouncementForm = z.infer<typeof announcementFormSchema>;

export const deleteAnnouncementSchema = z.object({
  id: z.preprocess((v) => Number(v), z.number().int().positive()),
});

// The allowance is JSON off another service and its numbers arrive in three shapes: a number, a
// numeric string (the creator score comes back quoted), and `null` — which is what a NaN score
// serialises to, and what crashed the notice on `toLocaleString`. Everything downstream gets a
// finite number or 0.
export const count = z.union([z.number(), z.string(), z.null(), z.undefined()]).transform((v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
});

// `limit` and `windowDays` decide whether the composer offers to post at all, so an absent or
// unreadable value has to fail the parse and show "allowance unavailable" — coercing it to 0 would
// render a confident "no slots left" for what is actually a broken upstream.
const required = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n)) {
    ctx.addIssue({ code: 'custom', message: 'Expected a number' });
    return z.NEVER;
  }
  return n;
});

export const allowanceSchema = z.object({
  eligible: z.boolean(),
  tier: z.string(),
  score: count,
  minScore: count,
  used: count,
  limit: required,
  windowDays: required,
  nextAvailableAt: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
});
