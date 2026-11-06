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

describe('sanitizeHtml span styles', () => {
  const span = (style: string) => `<span style="${style.replace(/"/g, '&quot;')}">x</span>`;

  it('keeps editor span colours exactly', () => {
    expect(sanitizeHtml(span('color:rgb(250, 82, 82)'))).toBe(span('color:rgb(250, 82, 82)'));
    expect(sanitizeHtml(span('color:#fab005'))).toBe(span('color:#fab005'));
  });

  it('drops other span styles', () => {
    expect(sanitizeHtml(span('display:block'))).toBe('<span>x</span>');
    expect(sanitizeHtml(span('color:red;margin-top:4px'))).toBe(span('color:red'));
  });

  it.each([
    ['background-color', 'rgba(0, 0, 0, 0.5)', 'url(x.png)'],
    ['font-size', '16px', '16vw'],
    ['font-size', '1.2rem', 'calc(100vh)'],
    ['line-height', '1.5', '9999px'],
    ['font-family', `"Segoe UI", Roboto, sans-serif`, 'x(y)'],
  ])('keeps a valid %s and drops an invalid one', (prop, valid, invalid) => {
    expect(sanitizeHtml(span(`${prop}:${valid}`))).toBe(span(`${prop}:${valid}`));
    expect(sanitizeHtml(span(`${prop}:${invalid}`))).toBe('<span>x</span>');
  });

  it("lets a caller's span styles replace the default for span only", () => {
    const allowedStyles = { span: { color: [/^red$/] } };
    expect(sanitizeHtml(span('color:red;font-size:16px'), { allowedStyles })).toBe(
      span('color:red')
    );
    expect(
      sanitizeHtml(span('display:block;color:red'), {
        allowedStyles: { div: { height: [/^1px$/] } },
      })
    ).toBe(span('color:red'));
  });

  it('drops span styles when style parsing is off', () => {
    expect(sanitizeHtml(span('color:red'), { parseStyleAttributes: false })).toBe('<span>x</span>');
  });
});

describe('sanitizeHtml links', () => {
  it('turns a link without href into plain text', () => {
    expect(sanitizeHtml('<a>x</a>')).toBe('<span>x</span>');
  });
});
