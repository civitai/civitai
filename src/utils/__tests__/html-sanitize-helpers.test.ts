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

  describe('text-align', () => {
    // Positive control: if this fails the allowlist is not wired, and the "still stripped" cases
    // below would pass for the wrong reason.
    it.each(['p', 'h1', 'h2', 'h3'])('keeps text-align:center on <%s>', (tag) => {
      expect(sanitizeHtml(`<${tag} style="text-align: center">x</${tag}>`)).toBe(
        `<${tag} style="text-align:center">x</${tag}>`
      );
    });

    it.each(['left', 'right'])('keeps text-align:%s', (value) => {
      expect(sanitizeHtml(`<p style="text-align:${value}">x</p>`)).toBe(
        `<p style="text-align:${value}">x</p>`
      );
    });

    it.each(['justify', 'CENTER', 'url(x)', 'inherit'])(
      'drops a text-align value of %j',
      (value) => {
        expect(sanitizeHtml(`<p style="text-align:${value}">x</p>`)).toBe('<p>x</p>');
      }
    );

    it('drops every other declaration, even beside a valid text-align', () => {
      expect(
        sanitizeHtml(
          '<p style="position:fixed;background:url(https://evil.test/x);text-align:center;top:0">x</p>'
        )
      ).toBe('<p style="text-align:center">x</p>');
      expect(sanitizeHtml('<p style="position:fixed">x</p>')).toBe('<p>x</p>');
    });

    it('does not allow text-align on tags outside p and h1-h3', () => {
      expect(sanitizeHtml('<li style="text-align:center">x</li>')).toBe('<li>x</li>');
      expect(sanitizeHtml('<blockquote style="text-align:center">x</blockquote>')).toBe(
        '<blockquote>x</blockquote>'
      );
    });

    it('drops the style attribute when the caller turned style parsing off', () => {
      expect(
        sanitizeHtml('<p style="position:fixed">x</p><p style="text-align:center">y</p>', {
          parseStyleAttributes: false,
        })
      ).toBe('<p>x</p><p>y</p>');
    });

    it('keeps a caller-supplied allowedStyles working beside the alignment rule', () => {
      expect(
        sanitizeHtml(
          '<div style="height:10px;color:red">x</div><p style="text-align:center">y</p>',
          {
            allowedAttributes: { div: ['style'], p: ['style'] },
            allowedStyles: { div: { height: [/^\d+px$/] } },
          }
        )
      ).toBe('<div style="height:10px">x</div><p style="text-align:center">y</p>');
    });

    it('leaves span styles as they were', () => {
      expect(sanitizeHtml('<span style="color: red; position:fixed">x</span>')).toBe(
        '<span style="color:red;position:fixed">x</span>'
      );
    });
  });
});
