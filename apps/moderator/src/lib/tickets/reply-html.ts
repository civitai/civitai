const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * A moderator's plain-text reply as the HTML Freshdesk emails. Everything typed is escaped, so markup in
 * a reply can never reach the customer as markup; blank lines become paragraphs, single newlines `<br>`.
 * Null when there is nothing to send.
 */
export function plainTextToHtml(text: string): string | null {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paragraphs.length) return null;
  return paragraphs
    .map((p) => `<p>${p.replace(/[&<>"']/g, (c) => ESCAPES[c]).replace(/\n/g, '<br>')}</p>`)
    .join('');
}
