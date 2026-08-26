import type { Transformer } from 'sanitize-html';
import sanitize from 'sanitize-html';
import { isValidURL } from '~/utils/type-guards';

const DEFAULT_ALLOWED_TAGS = [
  'p',
  'strong',
  'em',
  'u',
  's',
  'ul',
  'ol',
  'li',
  'a',
  'br',
  'img',
  'iframe',
  'div',
  'blockquote',
  'code',
  'pre',
  'span',
  'h1',
  'h2',
  'h3',
  'hr',
  'time',
  'edge-media',
];

// Must cover everything the comment editor's toolbar can produce: a tag missing
// here is stripped at save with no error, so the markup just vanishes.
export const COMMENT_ALLOWED_TAGS = [
  'div',
  'strong',
  'p',
  'em',
  'u',
  's',
  'a',
  'br',
  'span',
  'code',
  'pre',
];

const DEFAULT_ALLOWED_IFRAME_HOSTNAMES = [
  'www.youtube.com',
  'www.instagram.com',
  'www.strawpoll.com',
];

export const DEFAULT_ALLOWED_ATTRIBUTES = {
  a: ['rel', 'href', 'target'],
  img: ['src', 'alt', 'width', 'height'],
  iframe: [
    'src',
    'width',
    'height',
    'allowfullscreen',
    'autoplay',
    'disablekbcontrols',
    'enableiframeapi',
    'endtime',
    'ivloadpolicy',
    'loop',
    'modestbranding',
    'origin',
    'playlist',
    'start',
  ],
  div: ['data-youtube-video', 'data-type'],
  span: ['class', 'data-type', 'data-id', 'data-label', 'style'],
  time: ['datetime', 'data-type', 'data-value', 'data-style'],
  '*': ['id'],
  'edge-media': ['url', 'type', 'filename', 'className'],
};

// What may appear INSIDE a blurb span.
//
// 🔴 INLINE ONLY — never add a block element here. A blurb's text is spliced inside
// `<span data-type="blurb">`, which sits inside the host document's `<p>`. In the HTML parsing
// algorithm a block start tag (`p`, `div`, `ul`, `ol`, `li`, `pre`, `blockquote`, `h1`-`h3`)
// closes that open `<p>`, and `span` is not a formatting element so it is popped rather than
// reconstructed. The chip is left EMPTY and the text lands as a detached sibling — then the next
// save re-splices the body into the empty span and the text appears twice. Pinned against
// parse5/jsdom in blurb-inline-content.test.ts; happy-dom does not reproduce it, which is why
// this went unnoticed.
//
// Deliberately narrower than DEFAULT_ALLOWED_TAGS/DEFAULT_ALLOWED_ATTRIBUTES: a direct
// `blurb.update` call (no toolbar in the way) would otherwise write `iframe`, `span[style]`, or
// `edge-media` into stored content. No `span` at all, so mention/sticker/nested-blurb spoofing and
// the `style` vector both close the same way: the tag that would carry them isn't allowed.
export const BLURB_INTERIOR_ALLOWED_TAGS = ['strong', 'em', 'u', 's', 'a', 'br', 'code'];

export const BLURB_INTERIOR_ALLOWED_ATTRIBUTES = {
  a: DEFAULT_ALLOWED_ATTRIBUTES.a,
};

export const BLURB_INTERIOR_SANITIZE_OPTIONS = {
  allowedTags: BLURB_INTERIOR_ALLOWED_TAGS,
  allowedAttributes: BLURB_INTERIOR_ALLOWED_ATTRIBUTES,
};

/**
 * The one way to make a blurb's stored text safe to put inside an inline span. Every consumer
 * goes through this rather than re-stating the allowlist: `blurbContentSchema` at save,
 * `replaceBlurbSpans` at splice (both the save path and the fan-out reach it there), and
 * RenderRichText's blurb node mapping at render.
 *
 * Idempotent — call it whenever you are unsure.
 */
export function sanitizeBlurbInterior(html: string) {
  return sanitizeHtml(html, BLURB_INTERIOR_SANITIZE_OPTIONS);
}

// Stickers are paid goods. `span` and its data-* attributes are in the default
// allowlist (mentions need them), so sticker markup would otherwise survive on
// every rich-text surface — model descriptions, bounties, reviews, changelogs —
// and render as the paid sticker for anyone who pasted it, owned or not.
// Denied by default so a surface added later fails closed; the surfaces that
// charge for stickers opt in.
// Normalised so the strip is strictly BROADER than every consumer. All four
// matchers (the RenderHtml hydrator, Tiptap parseHTML, the id-collection regex
// and countStickerPlacements) are exact-lowercase today, so `STICKER` and
// ` sticker` render nowhere — but if any one of them is later made lenient
// about case or whitespace, a narrower strip would quietly open a gap.
const isStickerSpan = (frame: { tag: string; attribs: Record<string, string> }) =>
  frame.tag === 'span' && frame.attribs['data-type']?.trim().toLowerCase() === 'sticker';

// `span` and its data-* attributes are in the default allowlist, so without this a blurb span
// survives wherever it was pasted. Nothing creates a BlurbReference for an unregistered surface,
// so that copy is frozen at the text it was pasted with and silently never updates. Denied by
// default so a surface added later fails closed.
// Normalised deliberately: the matcher here must stay strictly BROADER than every consumer, all
// of which are exact-lowercase today.
const isBlurbAttribs = (attribs: Record<string, string>) =>
  attribs['data-type']?.trim().toLowerCase() === 'blurb';

export type santizeHtmlOptions = sanitize.IOptions & {
  stripEmpty?: boolean;
  /** Opt-in for surfaces that gate sticker ownership (chat, comments). */
  allowStickers?: boolean;
  /** Opt-in for surfaces registered with the blurb fan-out. */
  allowBlurbs?: boolean;
};
export function sanitizeHtml(html: string, args?: santizeHtmlOptions) {
  const {
    stripEmpty = false,
    allowStickers = false,
    allowBlurbs = false,
    transformTags,
    // Composed rather than passed through: `...options` spreads last, so a
    // caller-supplied filter would otherwise silently drop the sticker strip.
    exclusiveFilter,
    ...options
  } = args ?? {};
  return sanitize(html, {
    allowedTags: DEFAULT_ALLOWED_TAGS,
    allowedAttributes: DEFAULT_ALLOWED_ATTRIBUTES,
    exclusiveFilter: (frame) =>
      (!allowStickers && isStickerSpan(frame)) ||
      (stripEmpty && frame.tag === 'p' && !frame.text.trim()) ||
      (exclusiveFilter?.(frame) ?? false),
    allowedIframeHostnames: DEFAULT_ALLOWED_IFRAME_HOSTNAMES,
    transformTags: {
      a: function (tagName, { href, ...attr }) {
        const updatedHref = href.startsWith('http') ? href : `http://${href}`;
        const hrefDomain = isValidURL(updatedHref) ? new URL(updatedHref).hostname : undefined;
        if (!hrefDomain) return { tagName: 'span', ...attr };

        return {
          tagName: 'a',
          attribs: {
            ...attr,
            href,
            rel: 'ugc',
          },
        };
      } as Transformer,
      ...transformTags,
      // After the spread on purpose: a caller-supplied span transform must not be able to
      // reinstate the attributes. Mirrors why exclusiveFilter is composed rather than passed
      // through, and the sticker suite already pins that property.
      span: (tagName, attribs) => {
        const applied =
          typeof transformTags?.span === 'string'
            ? { tagName: transformTags.span, attribs }
            : transformTags?.span
            ? (transformTags.span as Transformer)(tagName, attribs)
            : { tagName, attribs };
        const next = applied.attribs ?? {};
        if (allowBlurbs || !isBlurbAttribs(next)) return applied;
        const { 'data-type': _type, 'data-id': _id, ...rest } = next;
        return { ...applied, attribs: rest };
      },
    },
    ...options,
  });
}
