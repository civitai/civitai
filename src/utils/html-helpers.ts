import sanitize from 'sanitize-html';

export function sanitizeHtml(html: string, options?: sanitize.IOptions) {
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
      div: ['data-youtube-video'],
      span: ['class', 'data-type', 'data-id', 'data-label'],
    },
    allowedIframeHostnames: ['www.youtube.com'],
    transformTags: {
      a: sanitize.simpleTransform('a', { rel: 'ugc' }),
    },
    ...options,
  });
}
