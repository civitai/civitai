import sanitize, { Transformer } from 'sanitize-html';
import linkBlocklist from '~/server/utils/link-blocklist.json';

export type santizeHtmlOptions = sanitize.IOptions & { stripEmpty?: boolean };
export function sanitizeHtml(
  html: string,
  { stripEmpty, ...options }: santizeHtmlOptions = { stripEmpty: false }
) {
  return sanitize(html, {
    allowedTags: [
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
    ],
    allowedAttributes: {
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
    },
    exclusiveFilter: stripEmpty
      ? (frame) => {
          return (
            frame.tag === 'p' && // The node is a p tag
            !frame.text.trim() // The element has no text
          );
        }
      : undefined,
    allowedIframeHostnames: ['www.youtube.com', 'www.instagram.com', 'www.strawpoll.com'],
    transformTags: {
      a: function (tagName, { href, ...attr }) {
        const hrefDomain = new URL(href).hostname;
        const isBlocked = linkBlocklist.some((domain) => domain === hrefDomain);
        if (isBlocked)
          return {
            tagName: 'span',
            text: '[Blocked Link]',
          };
        return {
          tagName: 'a',
          attribs: {
            ...attr,
            href,
            rel: 'ugc',
          },
        };
      } as Transformer,
    },
    ...options,
  });
}
