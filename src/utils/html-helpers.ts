import sanitize from 'sanitize-html';

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
      span: ['class', 'data-type', 'data-id', 'data-label'],
    },
    exclusiveFilter: stripEmpty
      ? (frame) => {
          return (
            frame.tag === 'p' && // The node is a p tag
            !frame.text.trim() // The element has no text
          );
        }
      : undefined,
    allowedIframeHostnames: ['www.youtube.com', 'www.instagram.com'],
    transformTags: {
      a: sanitize.simpleTransform('a', { rel: 'ugc' }),
    },
    ...options,
  });
}
