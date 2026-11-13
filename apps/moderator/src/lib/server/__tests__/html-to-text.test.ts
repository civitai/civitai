import { describe, expect, it } from 'vitest';
import {
  HTML_MAX_CHARS,
  TEXT_MAX_CHARS,
  convertHtml,
  decodeEntities,
  htmlToText,
} from '../html-to-text';

/**
 * Freshdesk description HTML → the text the ticket page shows. Synthetic inputs only, shaped like the
 * HTML mail clients send (div-per-line, `<div><br></div>` blank lines, nested lists, inline styling).
 */

describe('htmlToText', () => {
  it('keeps paragraphs as blank-line-separated blocks, and collapses source whitespace', () => {
    expect(htmlToText('<p>First   para\n  wraps</p>\n\n<p>Second</p>')).toBe(
      'First para wraps\n\nSecond'
    );
  });

  it('turns <br> into a line break, in all its spellings', () => {
    expect(htmlToText('one<br>two<br/>three<BR />four')).toBe('one\ntwo\nthree\nfour');
  });

  it('reads div-per-line mail, including the <div><br></div> blank line', () => {
    expect(
      htmlToText('<div>Hello,</div><div><br></div><div>Line one</div><div>Line two</div>')
    ).toBe('Hello,\n\nLine one\nLine two');
  });

  it('bullets list items, indents a nested list, and numbers an ordered one', () => {
    const html =
      '<p>Steps:</p><ul><li>alpha</li><li>beta<ul><li>beta-one</li><li>beta-two</li></ul></li>' +
      '<li>gamma</li></ul><ol><li>first</li><li>second</li></ol><p>After</p>';
    expect(htmlToText(html)).toBe(
      [
        'Steps:',
        '',
        '• alpha',
        '• beta',
        '  • beta-one',
        '  • beta-two',
        '• gamma',
        '',
        '1. first',
        '2. second',
        '',
        'After',
      ].join('\n')
    );
  });

  it('a list item wrapped in <p> keeps its text on the bullet line', () => {
    expect(htmlToText('<ul><li><p>wrapped</p></li><li>plain</li></ul>')).toBe(
      '• wrapped\n\n• plain'
    );
  });

  it('an empty list item leaves no orphan bullet', () => {
    expect(htmlToText('<ul><li></li><li> </li><li>real</li></ul>')).toBe('• real');
  });

  it('decodes entities AFTER tokenising, so escaped markup stays text', () => {
    expect(
      htmlToText('<p>5 &lt; 6 &amp;&amp; &lt;b&gt;not bold&lt;/b&gt; &#8212; &#x41;&nbsp;B</p>')
    ).toBe('5 < 6 && <b>not bold</b> — A B');
  });

  it('drops script, style and head content entirely — not just their tags', () => {
    const html =
      '<html><head><title>T-TITLE</title><style>.x{color:red}</style></head><body>' +
      '<script type="text/javascript">alert("S-BODY")</script><p>visible</p>' +
      '<SCRIPT>var x = "</p>";</SCRIPT></body></html>';
    const out = htmlToText(html);
    expect(out).toBe('visible');
  });

  it('an unclosed <head> (its end tag is optional) does NOT hide the body', () => {
    expect(
      convertHtml('<html><head><meta charset="utf-8"><body><p>REAL</p></body></html>')
    ).toEqual({ text: 'REAL', complete: true });
    expect(htmlToText('<noscript><p>shown</p>')).toBe('shown');
  });

  it('an UNCLOSED script swallows the rest, as a browser would', () => {
    expect(htmlToText('<p>kept</p><script>leak("x")<p>after</p>')).toBe('kept');
  });

  it('keeps a link as its text and drops the target', () => {
    expect(
      htmlToText('See <a href="https://example.test/x?a=1&amp;b=2" title="a > b">the guide</a>.')
    ).toBe('See the guide.');
  });

  it('drops comments, images and inline styling without losing adjacent words', () => {
    expect(
      htmlToText(
        '<!-- c --><p><strong>Bold</strong> and <em>em</em><img src="x.png" alt="pic"> end</p>'
      )
    ).toBe('Bold and em end');
  });

  it('a stray < that opens no tag is text', () => {
    expect(htmlToText('<p>a < b and i <3 it</p>')).toBe('a < b and i <3 it');
  });

  it('keeps whitespace inside <pre>', () => {
    expect(htmlToText('<pre>line 1\n  indented</pre><p>x</p>')).toBe('line 1\n  indented\n\nx');
  });

  it('separates table cells and rows', () => {
    expect(
      htmlToText('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>')
    ).toBe('a b\nc d');
  });

  it('plain text with no markup passes through, newlines collapsed like HTML would', () => {
    expect(htmlToText('just text')).toBe('just text');
    expect(htmlToText('')).toBe('');
  });
});

describe('htmlToText on hostile input', () => {
  it("a <br> before an item's text does not separate the bullet from it", () => {
    expect(htmlToText('<ul><li><br>text</li></ul>')).toBe('• text');
  });

  it('bounds its OUTPUT however deep the lists nest', () => {
    const out = htmlToText('y' + '<ul>'.repeat(20_000) + '<li>x'.repeat(20_000));
    expect(out.length).toBeLessThanOrEqual(TEXT_MAX_CHARS + 100);
    expect(out.split('\n')[2]).toBe(`${'  '.repeat(7)}• x`);
  });

  it('a tag cut off by the end of the input is dropped, not shown as raw markup', () => {
    expect(htmlToText('<p>question?</p><img src="data:image/png;base64,AAAA')).toBe('question?');
  });

  it('says whether it read the whole input — false for each of the three early stops', () => {
    expect(convertHtml('<p>all of it</p>').complete).toBe(true);
    expect(convertHtml('x'.repeat(HTML_MAX_CHARS + 1)).complete).toBe(false);
    expect(convertHtml(`<pre>${' '.repeat(TEXT_MAX_CHARS + 10)}</pre><p>after</p>`).complete).toBe(
      false
    );
    expect(convertHtml('<p>q</p><img src="data:,AAAA').complete).toBe(false);
  });

  it('runs of <br> do not spend the output cap on newlines nobody sees', () => {
    expect(convertHtml('<br>'.repeat(60_000) + '<p>REAL MESSAGE</p>')).toEqual({
      text: 'REAL MESSAGE',
      complete: true,
    });
  });

  it('reads at most HTML_MAX_CHARS of input', () => {
    expect(htmlToText('a'.repeat(HTML_MAX_CHARS) + 'TAIL')).not.toContain('TAIL');
  });

  // 🔴 A BUDGET, NOT A BENCHMARK. The quadratic version took 0.7–12 s on these at 40k–160k chars; a
  // linear one takes milliseconds. The bound is loose enough for a loaded CI box and still two orders
  // of magnitude under what a quadratic scan costs at this size.
  const n = 200_000;
  it.each([
    ['unclosed tag starts', '<a'.repeat(n / 2)],
    ['unclosed tag starts with a space', '<a '.repeat(n / 3)],
    ['unclosed quoted attributes', '<a "'.repeat(n / 4)],
    ['ordinary markup', '<p>x<b>y</b></p>'.repeat(n / 16)],
    ['unclosed scripts', '<script>x'.repeat(n / 9)],
    ['closed scripts', '<script>x</script>'.repeat(n / 18)],
    ['unclosed heads', '<head>x'.repeat(HTML_MAX_CHARS / 7)],
    ['spaces inside <pre>', `<pre>${' '.repeat(n - 20)}x</pre>`],
    ['newlines inside <pre>', `<pre>${'\n'.repeat(n - 20)}x</pre>`],
    ['spaces then a break, repeated', `${' '.repeat(1000)}x<br>`.repeat(n / 1006)],
    ['entities', '&lt;a'.repeat(n / 5)],
    [
      // Under TEXT_MAX_CHARS, so the output cap cannot be what stops it.
      'empty items after a long <pre> newline run',
      `<pre>x${'\n'.repeat(40_000)}</pre>` + '<li>'.repeat(40_000),
    ],
    // A budget invariant at the full input cap, not a guard on the look-ahead cache: every failed tag
    // emits text, so TEXT_MAX_CHARS bounds the iterations and an uncached look-ahead also passes.
    ['failed tags before one far-off >', '<a "'.repeat(HTML_MAX_CHARS / 4 - 1) + '>'],
    ['deeply nested lists', 'y' + '<ul>'.repeat(n / 8) + '<li>x'.repeat(n / 8)],
  ])('stays linear: %s', (_name, html) => {
    const t0 = performance.now();
    htmlToText(html);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe('decodeEntities', () => {
  it('leaves an unknown name as written and replaces an impossible code point', () => {
    expect(decodeEntities('&bogus; &#xD800; &#1114112; &AMP;')).toBe('&bogus; � � &');
  });
});
