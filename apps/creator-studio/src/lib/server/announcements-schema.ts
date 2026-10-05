import { z } from 'zod';
// Relative, not `$lib`: this module is unit-tested by the app's node vitest project, which has no
// SvelteKit plugin and cannot resolve the alias — an aliased import fails COLLECTION, which reads as
// zero tests rather than as a failure.
import { checkbox, numberish } from './form-fields';
import {
  CONTENT_CEILING,
  DOMAIN_COLORS,
  LINK_SLOTS,
  LINK_TEXT_MAX,
  TITLE_MAX,
} from '../announcements';

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
    // CONTENT_CEILING, not CONTENT_MAX: the main app enforces the real limit and grandfathers rows
    // that were already over it. Capping at CONTENT_MAX here would refuse those before they got there.
    content: z.string().trim().min(1, 'Add a message').max(CONTENT_CEILING),
    domain: domainList,
    profileOnly: checkbox,
    startsAt: optionalDate,
    endsAt: optionalDate,
    linkUrl: optionalText(2048),
    linkText: optionalText(LINK_TEXT_MAX),
    linkUrl2: optionalText(2048),
    linkText2: optionalText(LINK_TEXT_MAX),
    linkUrl3: optionalText(2048),
    linkText3: optionalText(LINK_TEXT_MAX),
    // The object key minted by the main app's upload endpoint. It becomes an `Image` row on the
    // server (resolveCoverImageId); this side never creates one, and the key is a UUID because
    // that endpoint mints it with randomUUID.
    coverKey: z.preprocess((v) => (v === '' || v == null ? undefined : v), z.uuid().optional()),
    coverWidth: optionalNumber,
    coverHeight: optionalNumber,
    coverMimeType: optionalText(100),
    coverSizeKB: optionalNumber,
  })
  .superRefine((v, ctx) => {
    for (const [urlKey, textKey] of LINK_SLOTS) {
      const url = v[urlKey];
      const text = v[textKey];
      // A path resolves on whichever site the reader is on, which is the point. `//host` is
      // protocol-relative and leaves the site despite looking like a path, so it is not one.
      if (url && !/^https?:\/\//i.test(url) && !/^\/(?!\/)/.test(url))
        ctx.addIssue({
          code: 'custom',
          message: 'Button link must be a full https:// URL or a path like /models/123',
          path: [urlKey],
        });
      if (!!url !== !!text)
        ctx.addIssue({
          code: 'custom',
          message: 'A button needs both a link and button text',
          path: [textKey],
        });
    }
  })
  .transform((v) => ({
    ...v,
    links: LINK_SLOTS.flatMap(([urlKey, textKey]) => {
      const link = v[urlKey];
      const linkText = v[textKey];
      return link && linkText ? [{ link, linkText }] : [];
    }),
  }));
// No start/end ordering refine: the main app slides the end forward (clampAnnouncementWindow);
// rejecting here means the clamp never runs.

export type AnnouncementForm = z.infer<typeof announcementFormSchema>;

/** The main app's announcement endpoint body for a parsed form. */
export function toSaveBody(form: AnnouncementForm) {
  return {
    id: form.id,
    title: form.title,
    content: form.content,
    domain: form.domain,
    profileOnly: form.profileOnly,
    startsAt: form.startsAt?.toISOString() ?? null,
    endsAt: form.endsAt?.toISOString() ?? null,
    // `action` as well, so a main app still on the single-button schema keeps the first button
    // rather than stripping `actions` as an unknown key and saving none. It ignores `action`
    // once it reads `actions`.
    ...(form.links.length ? { action: form.links[0], actions: form.links } : {}),
    // A key, never an `Image` id: the server mints the row so the cover gets ingested and scanned.
    ...(form.coverKey
      ? {
          coverImage: {
            url: form.coverKey,
            width: form.coverWidth,
            height: form.coverHeight,
            mimeType: form.coverMimeType,
            sizeKB: form.coverSizeKB,
          },
        }
      : {}),
  };
}

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
// unreadable value has to fail the parse rather than coerce to 0 — a 0 would render a confident
// "no broadcasts left" for what is actually a broken upstream. A failed parse surfaces as the
// Broadcasts left card saying it could not load, and the composer stays usable because the limit is
// re-checked server-side on save.
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
