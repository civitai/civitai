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

    // `!important` rides along on an allowed value; it cannot carry another property or value.
    it('keeps only an allowed value when `!important` is attached', () => {
      expect(sanitizeHtml('<p style="text-align:center !important">x</p>')).toBe(
        '<p style="text-align:center !important">x</p>'
      );
      expect(sanitizeHtml('<p style="text-align:justify !important">x</p>')).toBe('<p>x</p>');
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
      expect(sanitizeHtml('<span style="color: red">x</span>')).toBe(
        '<span style="color:red">x</span>'
      );
    });
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
    ['background-color', 'rgb(1, 2, 3)', 'rgb(1, 2, 3) url(x)'],
    ['color', 'hsl(0, 50%, 50%)', '#ggg'],
    ['color', 'oklch(0.7 0.1 200 / 50%)', 'oklch(var(--x))'],
    ['background-color', 'color(srgb 1 0.5 0)', 'color(srgb url(x))'],
    ['font-size', 'large', 'large)x'],
    ['font-size', '2em', '10rem'],
    ['font-size', '99px', '100px'],
    ['font-size', '24pt', '5000px'],
    ['line-height', '9.5', '10'],
    ['line-height', 'normal', 'normal)x'],
    ['font-family', `"Segoe UI", Roboto, sans-serif`, 'x(y)'],
    ['font-family', 'Arial', 'a'.repeat(301)],
    ['font-family', 'Arial', 'url(x)'],
    ['font-family', 'Arial', 'var(--x)'],
    ['font-family', 'Arial', 'expression(x)'],
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

  it('drops styles when style parsing is off', () => {
    expect(sanitizeHtml(span('color:red'), { parseStyleAttributes: false })).toBe('<span>x</span>');
    expect(
      sanitizeHtml('<p style="color:red">x</p>', {
        parseStyleAttributes: false,
        allowedAttributes: { p: [{ name: 'style', multiple: false, values: [] }], '*': ['style'] },
      })
    ).toBe('<p>x</p>');
    expect(
      sanitizeHtml('<p style="color:red">x</p>', {
        parseStyleAttributes: false,
        allowedAttributes: { p: ['s*'], '*': ['*'] },
      })
    ).toBe('<p>x</p>');
  });

  it("ignores a caller's `*` style entry", () => {
    expect(
      sanitizeHtml(span('margin-top:4px;color:red'), {
        allowedStyles: { '*': { 'margin-top': [/.*/] } },
      })
    ).toBe(span('color:red'));
  });

  it('drops styles on a tag with no style allowlist of its own', () => {
    expect(
      sanitizeHtml('<p style="color:red">x</p>', { allowedAttributes: { p: ['style'] } })
    ).toBe('<p>x</p>');
  });
});

describe('sanitizeHtml links', () => {
  it('turns a link without href into plain text', () => {
    expect(sanitizeHtml('<a>x</a>')).toBe('<span>x</span>');
  });

  it('turns a link with an unparseable href into plain text', () => {
    expect(sanitizeHtml('<a href="not a url">x</a>')).toBe('<span>x</span>');
  });
});
