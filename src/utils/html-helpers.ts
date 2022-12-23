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
    },
    allowedIframeHostnames: ['www.youtube.com'],
    transformTags: {
      a: sanitize.simpleTransform('a', { rel: 'ugc' }),
    },
    ...options,
  });
}
