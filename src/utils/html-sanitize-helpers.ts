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

export type santizeHtmlOptions = sanitize.IOptions & {
  stripEmpty?: boolean;
  /** Opt-in for surfaces that gate sticker ownership (chat, comments). */
  allowStickers?: boolean;
};
export function sanitizeHtml(html: string, args?: santizeHtmlOptions) {
  const {
    stripEmpty = false,
    allowStickers = false,
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
    },
    ...options,
  });
}
