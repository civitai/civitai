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
  'code',
  'pre',
  'span',
  'h1',
  'h2',
  'h3',
  'hr',
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
  '*': ['id'],
  'edge-media': ['url', 'type', 'filename', 'className'],
};

export type santizeHtmlOptions = sanitize.IOptions & {
  stripEmpty?: boolean;
};
export function sanitizeHtml(html: string, args?: santizeHtmlOptions) {
  const { stripEmpty = false, transformTags, ...options } = args ?? {};
  // if (throwOnBlockedDomain) {
  //   const blockedDomains = getBlockedDomains(html);
  //   if (blockedDomains.length) throw new Error(`invalid urls: ${blockedDomains.join(', ')}`);
  // }
  return sanitize(html, {
    allowedTags: DEFAULT_ALLOWED_TAGS,
    allowedAttributes: DEFAULT_ALLOWED_ATTRIBUTES,
    exclusiveFilter: stripEmpty
      ? (frame) => {
          return (
            frame.tag === 'p' && // The node is a p tag
            !frame.text.trim() // The element has no text
          );
        }
      : undefined,
    allowedIframeHostnames: DEFAULT_ALLOWED_IFRAME_HOSTNAMES,
    transformTags: {
      a: function (tagName, { href, ...attr }) {
        const updatedHref = href.startsWith('http') ? href : `http://${href}`;
        const hrefDomain = isValidURL(updatedHref) ? new URL(updatedHref).hostname : undefined;
        if (!hrefDomain) return { tagName: 'span', ...attr };

        // const isBlocked = getIsBlockedDomain(hrefDomain);
        // if (isBlocked)
        //   return {
        //     tagName: 'span',
        //     text: '[Blocked Link]',
        //   };
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
