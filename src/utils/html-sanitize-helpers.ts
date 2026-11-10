import { decode } from 'he';
import type { Transformer } from 'sanitize-html';
import sanitize from 'sanitize-html';
import { removeTags } from '~/utils/string-helpers';
import { isValidURL } from '~/utils/type-guards';
import {
  EMBED_PLAYER_HOSTS,
  isAllowedPlayerUrl,
  isEmbedPlayerHost,
} from '~/shared/utils/embed-providers';
import { IMAGE_WIDTHS } from '~/shared/tiptap/image-width';

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
  ...EMBED_PLAYER_HOSTS,
];

// The article editor's per-image size. sanitize-html blanks any value off this list, so a
// stored `data-width` can't carry CSS.
const IMAGE_WIDTH_ATTRIBUTE = { name: 'data-width', multiple: false, values: [...IMAGE_WIDTHS] };
// `style` is allowed on these tags only because `allowedStyles` limits it to text-align left|center|right.
const TEXT_ALIGN_TAGS = ['p', 'h1', 'h2', 'h3'];
const TEXT_ALIGN_STYLES = Object.fromEntries(
  TEXT_ALIGN_TAGS.map((tag) => [tag, { 'text-align': [/^(left|center|right)$/] }])
);

export const DEFAULT_ALLOWED_ATTRIBUTES = {
  a: ['rel', 'href', 'target', 'data-entity', 'data-id', 'data-version-id'],
  img: ['src', 'alt', 'width', 'height', IMAGE_WIDTH_ATTRIBUTE],
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
  // `data-id` is load-bearing for blurbs: it is the only thing tying a stored blurb back to its
  // row, and every host body passes through here on save. Drop it and the fan-out has nothing
  // left to find — the words stay and silently stop updating.
  div: ['data-youtube-video', 'data-type', 'data-id', 'data-provider'],
  span: ['class', 'data-type', 'data-id', 'data-label', 'style'],
  ...Object.fromEntries(TEXT_ALIGN_TAGS.map((tag) => [tag, ['style']])),
  time: ['datetime', 'data-type', 'data-value', 'data-style'],
  '*': ['id'],
  'edge-media': ['url', 'type', 'filename', 'className', IMAGE_WIDTH_ATTRIBUTE],
};

// What may appear INSIDE a blurb.
//
// 🔴 NO `div` — that is the blurb's own wrapper. One nested here is found by `findBlurbSpans` as
// a blurb in its own right, so a hand-crafted `blurb.update` could splice a `data-id` naming
// someone else's row inside its own body and have the fan-out keep it fresh.
//
// 🔴 `span` carries NO `data-*`, only `style`. It is here for text colour alone. Grant it
// `data-type` and mention, sticker and nested-blurb spoofing all reopen through the one tag —
// which is why the attribute allowlist below is the control, not the tag list.
//
// Deliberately narrower than DEFAULT_ALLOWED_TAGS/DEFAULT_ALLOWED_ATTRIBUTES: a direct
// `blurb.update` call reaches this with no toolbar in the way, and would otherwise write
// `iframe`, `img` or `edge-media` into content that renders on every entity using the blurb.
export const BLURB_INTERIOR_ALLOWED_TAGS = [
  'p',
  'strong',
  'em',
  'u',
  's',
  'a',
  'br',
  'code',
  'span',
  'h1',
  'h2',
  'h3',
  'ul',
  'ol',
  'li',
];

export const BLURB_INTERIOR_ALLOWED_ATTRIBUTES = {
  a: DEFAULT_ALLOWED_ATTRIBUTES.a,
  span: ['style'],
};

// `allowedStyles` is an allowlist of PROPERTIES as well as values, so `color` being the only key
// is what stops `style` becoming a general-purpose vector — `position`, `background`, and the
// `url()` in anything image-shaped are all refused by omission rather than by pattern.
export const CSS_COLOR = [
  /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i,
  /^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*[\d.]+\s*)?\)$/i,
  /^hsla?\(\s*[\d.]+\s*,\s*[\d.]+%\s*,\s*[\d.]+%\s*(?:,\s*[\d.]+\s*)?\)$/i,
  /^[a-z]+$/i,
];

// Pasted text keeps the source page's color syntax, so spans also accept the numeric-only
// space-separated forms (oklch(), lab(), color(srgb …), rgb(0 0 0 / 50%)).
const SPAN_COLOR = [
  ...CSS_COLOR,
  /^(?:rgba?|hsla?|lab|lch|oklab|oklch)\(\s*[-\d.%\s/]+\)$/i,
  /^color\(\s*(?:srgb|srgb-linear|display-p3)\s+[-\d.%\s/]+\)$/i,
];
const CSS_GLOBAL = /^(?:inherit|initial|unset)$/i;
// Bounded: under 100px/pt, under 1000%, under 10em/rem.
const CSS_LENGTH =
  /^(?:\d{1,2}(?:\.\d+)?|\.\d+)(?:px|pt)$|^\d{1,3}(?:\.\d+)?%$|^\d(?:\.\d+)?r?em$/i;

// The properties TextStyleKit (the editor's `colors` control) writes on a span.
export const SPAN_ALLOWED_STYLES = {
  color: SPAN_COLOR,
  'background-color': SPAN_COLOR,
  'font-size': [
    CSS_LENGTH,
    CSS_GLOBAL,
    /^(?:xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger)$/i,
  ],
  'line-height': [CSS_LENGTH, CSS_GLOBAL, /^normal$/i, /^\d(?:\.\d+)?$/],
  'font-family': [/^[\p{L}\p{N} "',-]{1,300}$/u],
};

export const BLURB_INTERIOR_SANITIZE_OPTIONS = {
  allowedTags: BLURB_INTERIOR_ALLOWED_TAGS,
  allowedAttributes: BLURB_INTERIOR_ALLOWED_ATTRIBUTES,
  allowedStyles: { span: { color: CSS_COLOR } },
};

/**
 * A blurb's text as the reader sees it. Entities stay encoded through `removeTags`, and the
 * editor and sanitize-html encode them differently (`&nbsp;` vs U+00A0), so the cap and the
 * counter only agree once decoded. Inline tags are removed outright first, because `removeTags`
 * spaces every tag and bolding half a word would otherwise count a character.
 */
const BLURB_INLINE_TAG = /<\/?(?:strong|em|u|s|a|span|code)\b[^>]*>/gi;
export function getBlurbText(html: string) {
  return decode(removeTags(html.replace(BLURB_INLINE_TAG, '')));
}

/**
 * The one way to make a blurb's stored text safe to splice into a host body. Every consumer
 * goes through this rather than re-stating the allowlist: `blurbContentSchema` at save,
 * `replaceBlurbSpans` at splice (both the save path and the fan-out reach it there), and
 * RenderRichText's blurb node mapping at render.
 *
 * Idempotent — call it whenever you are unsure.
 */
export function sanitizeBlurbInterior(html: string, rewriteHref?: (href: string) => string) {
  const sanitized = sanitizeHtml(html, BLURB_INTERIOR_SANITIZE_OPTIONS);
  if (!rewriteHref) return sanitized;
  // A second pass rather than an `a` transform on the first: a caller's `a` replaces the
  // wrapper's default one instead of composing with it.
  return sanitizeHtml(sanitized, {
    ...BLURB_INTERIOR_SANITIZE_OPTIONS,
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: attribs.href ? { ...attribs, href: rewriteHref(attribs.href) } : attribs,
      }),
    },
  });
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

// `div` and its data-* attributes are in the default allowlist, so without this a blurb
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
// The hostname allowlist admits any path on a player host. A new-provider iframe must also
// match its provider's player URL shape (isAllowedPlayerUrl), or it is dropped whole.
function isRefusedEmbedIframe(frame: sanitize.IFrame) {
  if (frame.tag !== 'iframe') return false;
  const src = frame.attribs.src;
  return isEmbedPlayerHost(src) && !isAllowedPlayerUrl(src);
}

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

  // With parseStyleAttributes off, sanitize-html passes `style` through unfiltered and throws if
  // allowedStyles is set, so `style` is dropped from every tag and allowedStyles is omitted.
  // `allowedAttributes: false` (allow everything) stays the caller's explicit choice.
  const parsesStyles = options.parseStyleAttributes !== false;
  const suppliedAttributes = options.allowedAttributes ?? DEFAULT_ALLOWED_ATTRIBUTES;
  const allowedAttributes =
    parsesStyles || !suppliedAttributes
      ? suppliedAttributes
      : Object.fromEntries(
          Object.entries(suppliedAttributes).map(([tag, attrs]) => [
            tag,
            (attrs ?? []).filter((attr) => {
              const name = typeof attr === 'string' ? attr : attr.name;
              // A glob such as `s*` or `*` would also admit `style`.
              return name !== 'style' && !name.includes('*');
            }),
          ])
        );

  const stripBlurbMarker: Transformer = (tagName, attribs) => {
    const supplied = transformTags?.div;
    const applied =
      typeof supplied === 'string'
        ? { tagName: supplied, attribs }
        : supplied
        ? (supplied as Transformer)(tagName, attribs)
        : { tagName, attribs };
    const next = applied.attribs ?? {};
    if (allowBlurbs || !isBlurbAttribs(next)) return applied;
    const { 'data-type': _type, 'data-id': _id, ...rest } = next;
    return { ...applied, attribs: rest };
  };

  return sanitize(html, {
    allowedTags: DEFAULT_ALLOWED_TAGS,
    exclusiveFilter: (frame) =>
      (!allowStickers && isStickerSpan(frame)) ||
      (stripEmpty && frame.tag === 'p' && !frame.text.trim()) ||
      isRefusedEmbedIframe(frame) ||
      (exclusiveFilter?.(frame) ?? false),
    transformTags: {
      a: function (tagName, { href, ...attr }) {
        if (!href) return { tagName: 'span', attribs: {} };
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
      // After the spread on purpose: a caller-supplied transform must not be able to reinstate
      // the attributes. Mirrors why exclusiveFilter is composed rather than passed through, and
      // the sticker suite already pins that property.
      div: stripBlurbMarker,
    },
    ...options,
    allowedAttributes,
    // After the spread so no caller option can widen which iframes load.
    allowedIframeHostnames: DEFAULT_ALLOWED_IFRAME_HOSTNAMES,
    allowedIframeDomains: [],
    allowIframeRelativeUrls: false,
    // Per-tag replace, not merge: a caller's entry for a tag replaces its default (span, p, h1-h3). `*` is
    // fixed empty, after the spread, because sanitize-html merges it into every tag's rule; it
    // drops style on any tag without its own entry.
    allowedStyles: parsesStyles
      ? { span: SPAN_ALLOWED_STYLES, ...TEXT_ALIGN_STYLES, ...options.allowedStyles, '*': {} }
      : undefined,
  });
}

const TEXT_STYLE_ATTR_PROPERTIES = {
  color: 'color',
  backgroundColor: 'background-color',
  fontFamily: 'font-family',
  fontSize: 'font-size',
  lineHeight: 'line-height',
} as const;

type TiptapJSON = {
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: TiptapJSON[];
};

/**
 * Applies SPAN_ALLOWED_STYLES to the textStyle marks of a Tiptap JSON doc, in place: an attribute
 * whose value a span style would not keep is cleared. Link marks drop `class`, matching what the
 * save sanitizer keeps on `a`. For docs parsed from stored HTML.
 */
export function boundTextStyleMarks<T extends TiptapJSON>(node: T): T {
  for (const mark of node.marks ?? []) {
    if (mark.type === 'link' && mark.attrs) mark.attrs.class = null;
    if (mark.type !== 'textStyle' || !mark.attrs) continue;
    for (const [attr, property] of Object.entries(TEXT_STYLE_ATTR_PROPERTIES)) {
      const value = mark.attrs[attr];
      if (value == null) continue;
      const allowed =
        typeof value === 'string' &&
        SPAN_ALLOWED_STYLES[property].some((pattern) => pattern.test(value.trim()));
      if (!allowed) mark.attrs[attr] = null;
    }
  }
  node.content?.forEach(boundTextStyleMarks);
  return node;
}

/**
 * Drops spoiler text and spoiler blocks, for anything that turns a body into a public excerpt:
 * meta descriptions, share cards, search documents. Moderation must keep reading the full body,
 * or a spoiler becomes a way to hide text from it.
 *
 * Not a sanitiser: every other tag passes through. Strip tags or sanitise the result.
 */
export function removeSpoilers(html: string) {
  // Most bodies hold none, and this runs over every article on a search reindex.
  if (!html || !/spoiler/i.test(html)) return html;
  return sanitize(html, {
    allowedTags: false,
    allowedAttributes: false,
    // Normalised so the strip stays broader than the editor and renderer, which match exactly.
    exclusiveFilter: (frame) => frame.attribs['data-type']?.trim().toLowerCase() === 'spoiler',
  });
}
