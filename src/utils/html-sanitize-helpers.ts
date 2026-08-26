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
  // `data-id` is load-bearing for blurbs: it is the only thing tying a stored blurb back to its
  // row, and every host body passes through here on save. Drop it and the fan-out has nothing
  // left to find — the words stay and silently stop updating.
  div: ['data-youtube-video', 'data-type', 'data-id'],
  span: ['class', 'data-type', 'data-id', 'data-label', 'style'],
  time: ['datetime', 'data-type', 'data-value', 'data-style'],
  '*': ['id'],
  'edge-media': ['url', 'type', 'filename', 'className'],
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

export const BLURB_INTERIOR_SANITIZE_OPTIONS = {
  allowedTags: BLURB_INTERIOR_ALLOWED_TAGS,
  allowedAttributes: BLURB_INTERIOR_ALLOWED_ATTRIBUTES,
  allowedStyles: { span: { color: CSS_COLOR } },
};

/**
 * The one way to make a blurb's stored text safe to splice into a host body. Every consumer
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

// `div`/`span` and their data-* attributes are in the default allowlist, so without this a blurb
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

  // Built per tag rather than written twice: a blurb is a `div` today and was a `span` before it
  // could hold headings and lists, and a body reaching here may still carry either.
  const stripBlurbMarker =
    (tag: 'div' | 'span'): Transformer =>
    (tagName, attribs) => {
      const supplied = transformTags?.[tag];
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
      // After the spread on purpose: a caller-supplied transform must not be able to reinstate
      // the attributes. Mirrors why exclusiveFilter is composed rather than passed through, and
      // the sticker suite already pins that property.
      div: stripBlurbMarker('div'),
      span: stripBlurbMarker('span'),
    },
    ...options,
  });
}
