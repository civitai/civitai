/**
 * Feature Pages comments are plain text in the frame and on the platform, and HTML in CommentV3 like
 * every other comment. These two are inverses for any text with \n line endings (CR and CRLF become
 * \n): one paragraph, lines split by `<br>`, the five HTML specials escaped.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const UNESCAPES = Object.fromEntries(Object.entries(ESCAPES).map(([k, v]) => [v, k]));

export function fpTextToHtml(text: string) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return `<p>${lines.map((line) => line.replace(/[&<>"']/g, (c) => ESCAPES[c])).join('<br>')}</p>`;
}

export function fpHtmlToText(html: string) {
  return html
    .replace(/^<p>/, '')
    .replace(/<\/p>$/, '')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/&(amp|lt|gt|quot|#39);/g, (entity) => UNESCAPES[entity] ?? entity);
}
