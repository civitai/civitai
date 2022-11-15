import sanitize from 'sanitize-html';

export function sanitizeHtml(html: string) {
  return sanitize(html, {
    allowedTags: ['p', 'strong', 'em', 'u', 's', 'ul', 'ol', 'li', 'a', 'br'],
    allowedAttributes: {
      a: ['rel', 'href', 'target'],
    },
    transformTags: {
      a: sanitize.simpleTransform('a', { rel: 'ugc' }),
    },
  });
}
