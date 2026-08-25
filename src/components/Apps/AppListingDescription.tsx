import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';

/**
 * The elements an app-listing description may render.
 *
 * 🔴 This is an ALLOWLIST, and it is deliberately explicit rather than absent.
 *
 * `CustomMarkdown` leaves `allowedElements` as `undefined` when a caller passes
 * none, and `undefined` in react-markdown means EVERYTHING is permitted. The
 * listing detail body used to call it that way. That was survivable while the
 * detail body was the only markdown surface; this change puts markdown on two
 * more (the app detail page and the details modal), so the element set is now
 * stated instead of inherited.
 *
 * What is NOT here, and why:
 *
 * - **`img`** — a markdown image (`![alt](https://…)`) renders a real `<img>`,
 *   which loads an author-controlled remote URL in every viewer's browser. A
 *   listing already has a first-class image channel — the screenshot gallery,
 *   whose images are auto-discovered from the submitted bundle,
 *   magic-byte-validated and MOD-REVIEWED before approval. An unmoderated image
 *   channel inside the description is redundant with a moderated one, so the
 *   description is text. (The alt text is preserved on the teaser/meta surfaces
 *   by `appListingDescriptionToPlainText`.)
 * - **`iframe`** — only reachable via `CustomMarkdown`'s `allowExternalVideo`,
 *   which we do not pass. Listed here so the omission reads as a decision.
 * - **table elements** — GFM tables need `remark-gfm`, which this surface does
 *   not load, so `th`/`td` are unreachable here regardless. Kept out so the
 *   allowlist describes what can actually render.
 *
 * Note this is not an XSS boundary and does not need to be: react-markdown does
 * not parse raw HTML without `rehype-raw`, which this surface also does not
 * load. Raw `<script>` in a description is inert text either way. The concern
 * this list addresses is remote-resource embedding, not script injection.
 *
 * `CustomMarkdown` unions `time` in on top of whatever we pass, so Discord-style
 * `<t:UNIX:STYLE>` timestamps keep working.
 */
export const APP_LISTING_DESCRIPTION_ALLOWED_ELEMENTS = [
  // text + inline formatting
  'p',
  'br',
  'strong',
  'em',
  'a',
  // literal syntax — the reason authors reach for backticks in the first place
  'code',
  'pre',
  // structure
  'ul',
  'ol',
  'li',
  'blockquote',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
];

/**
 * The full-surface renderer for an app-listing `description`.
 *
 * Use this on every surface whose job is to SHOW the description: the listing
 * detail body, `/apps/[appBlockId]`, and the details modal. Surfaces that cannot
 * render markdown (the card's 3-line clamp, `<meta>`) use
 * `appListingDescriptionToPlainText` instead — see `appListingDescription.ts`
 * for the full rule and why it is split this way.
 *
 * Layout is the caller's business: the detail body wraps this in a
 * `ContentClamp`, the modal does not. Only the RENDERING is shared, because the
 * rendering is what authors need to be able to predict.
 */
export function AppListingDescription({ description }: { description: string }) {
  return (
    <div className="markdown-content">
      <CustomMarkdown allowedElements={APP_LISTING_DESCRIPTION_ALLOWED_ELEMENTS}>
        {description}
      </CustomMarkdown>
    </div>
  );
}
