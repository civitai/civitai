import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from '~/utils/html-sanitize-helpers';

describe('sanitizeHtml', () => {
  // StarterKit's Blockquote is enabled whenever the `formatting` control is, so
  // `> ` in any article editor produces one — but the tag was never allowlisted,
  // so it was unwrapped on save while the CSS for it already shipped.
  it('keeps blockquotes', () => {
    expect(sanitizeHtml('<blockquote><p>quoted</p></blockquote>')).toBe(
      '<blockquote><p>quoted</p></blockquote>'
    );
  });

  it('still drops tags outside the allowlist', () => {
    expect(sanitizeHtml('<table><tr><td>x</td></tr></table>')).toBe('x');
    expect(sanitizeHtml('<script>alert(1)</script>')).toBe('');
  });

  it('forces rel="ugc" on links', () => {
    expect(sanitizeHtml('<a href="https://example.com">x</a>')).toContain('rel="ugc"');
  });
});
