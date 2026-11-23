const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Text as HTML that shows exactly that text: `& < > " '` become entities, everything else passes
 * through. Safe in element content and in a single- or double-quoted attribute value. Not a URL
 * check: an escaped `javascript:` href is still a `javascript:` href.
 */
export const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
