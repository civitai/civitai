// Kept in step by hand with `MAX_BLURBS_PER_USER` in `~/server/services/blurb.service`, which is
// the enforcement point. The picker needs the ceiling client-side and that module reaches Prisma,
// so it cannot be the import.
export const MAX_BLURBS_PER_USER = 20;

// `Blurb.id` is SERIAL (int4). Only `isBlurbId` and its tests read this.
export const MAX_BLURB_ID = 2_147_483_647;

/**
 * Whether a raw `data-id` attribute can name a real blurb row.
 *
 * 🔴 The int4 ceiling is not tidiness. Ids reach `blurb.findMany` straight from parsed markup, and
 * Prisma THROWS on one past int4 (`ConversionError`) rather than matching nothing — inside
 * `expandBlurbs`, which every enabled surface calls on save. Unbounded, a body carrying a large
 * `data-id` 500s the creator's save; bounded, the span is ignored. `sanitizeHtml` keeps `data-id`
 * without reading its value, so the markup does reach here.
 *
 * 🔴 ONE predicate for BOTH parsers — the Tiptap node's `parseHTML` and the server's
 * `findBlurbSpans` — over the same markup. Hand-synced bounds diverged once: the node capped at 9
 * digits and the server at int4 max, so an id between them parsed to `id: null` in the editor while
 * the server still resolved it. `renderHTML` emits `data-id` only for a truthy id, so the next save
 * dropped the reference and the blurb quietly became plain text. Add a call site, call this.
 */
export const isBlurbId = (raw: string | null | undefined): raw is string =>
  !!raw && /^\d+$/.test(raw) && Number(raw) <= MAX_BLURB_ID;
