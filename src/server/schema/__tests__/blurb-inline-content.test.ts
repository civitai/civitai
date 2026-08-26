// @vitest-environment jsdom
//
// jsdom, NOT the suite's default `node` environment, and NOT happy-dom. This file exists to pin
// behaviour of the SPEC HTML parsing algorithm, which is what a real browser runs when the
// article editor loads a saved body. Measured 2026-08-25 on the same three fixtures:
//   - node (@tiptap/html's own DOM shim) does not hoist
//   - happy-dom does not hoist
//   - jsdom (parse5) hoists, exactly as Chrome does
// So a version of this file in either other environment passes whether or not the bug is fixed.
import { describe, expect, it } from 'vitest';
import { createBlurbInputSchema } from '~/server/schema/blurb.schema';
import { BLURB_INTERIOR_ALLOWED_TAGS } from '~/utils/html-sanitize-helpers';

const store = (content: string) => createBlurbInputSchema.parse({ name: 'n', content }).content;

/** What the article body looks like once `replaceBlurbSpans` has spliced a blurb into it. */
const splicedIntoArticle = (blurbContent: string) =>
  `<p>before <span data-type="blurb" data-id="7">${blurbContent}</span> after</p>`;

/** The browser's own parse of that body — what the editor sees when it reopens the article. */
const reparse = (html: string) => {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
};

const blurbSpanText = (host: HTMLElement) =>
  host.querySelector('[data-type="blurb"]')?.innerHTML ?? null;

describe('blurb content is inline-only', () => {
  // The fixture gap that hid this: every other blurb fixture in the suite is tag-free
  // ('REAL', 'NEW', 'hi'), so nothing ever put a block element inside a blurb span.
  it.each([
    ['a paragraph', '<p>blurb text</p>', 'blurb text'],
    ['a bullet list', '<ul><li>one</li><li>two</li></ul>', 'onetwo'],
    ['a heading', '<h1>shouty</h1>', 'shouty'],
    ['a code block', '<pre><code>x = 1</code></pre>', '<code>x = 1</code>'],
    ['a blockquote', '<blockquote>quoted</blockquote>', 'quoted'],
    ['a div', '<div>boxed</div>', 'boxed'],
  ])('strips %s at save, keeping its text', (_label, input, expected) => {
    expect(store(input)).toBe(expected);
  });

  it('keeps the inline formatting the blurb toolbar can produce', () => {
    expect(store('<p><strong>bold</strong> and <em>italic</em> and <code>code</code></p>')).toBe(
      '<strong>bold</strong> and <em>italic</em> and <code>code</code>'
    );
  });

  it('turns paragraph boundaries into line breaks rather than running the words together', () => {
    // Without the preprocess this is `firstsecond` — two sentences silently joined.
    expect(store('<p>first</p><p>second</p>')).toBe('first<br />second');
  });

  it('allows no block tag through the shared allowlist', () => {
    const block = ['p', 'div', 'ul', 'ol', 'li', 'pre', 'blockquote', 'h1', 'h2', 'h3'];
    expect(BLURB_INTERIOR_ALLOWED_TAGS.filter((tag) => block.includes(tag))).toEqual([]);
  });
});

describe('a spliced blurb survives the browser re-parse', () => {
  it('keeps its text inside the span', () => {
    const host = reparse(splicedIntoArticle(store('<p>blurb text</p>')));

    expect(blurbSpanText(host)).toBe('blurb text');
    // One paragraph, not three: nothing was hoisted out into a sibling.
    expect(host.querySelectorAll('p')).toHaveLength(1);
  });

  it('keeps inline formatting inside the span', () => {
    const host = reparse(
      splicedIntoArticle(store('<p><strong>bold</strong> and <em>italic</em></p>'))
    );

    expect(blurbSpanText(host)).toBe('<strong>bold</strong> and <em>italic</em>');
  });

  it('EMPTIES the span when a block element is stored — the regression this guards', () => {
    // Revert either half of the fix and the assertions above start producing THIS instead: an
    // empty chip, the text hoisted into a sibling paragraph, and — because `expandBlurbs`
    // re-splices into the now-empty span on the author's next save — the text twice.
    const host = reparse(splicedIntoArticle('<p>blurb text</p>'));

    expect(blurbSpanText(host)).toBe('');
    expect(host.querySelectorAll('p').length).toBeGreaterThan(1);
    expect(host.textContent).toContain('blurb text');
  });

  it('EMPTIES the span for a list too, which is why the toolbar cannot offer one', () => {
    const host = reparse(splicedIntoArticle('<ul><li>one</li></ul>'));

    expect(blurbSpanText(host)).toBe('');
    expect(host.querySelector('ul')?.closest('[data-type="blurb"]')).toBeNull();
  });
});
