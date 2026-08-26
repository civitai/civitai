// @vitest-environment jsdom
//
// jsdom, NOT the suite's default `node` environment, and NOT happy-dom. This file exists to pin
// behaviour of the SPEC HTML parsing algorithm, which is what a real browser runs when the
// article editor loads a saved body. Measured 2026-08-25 on the same three fixtures:
//   - node (@tiptap/html's own DOM shim) does not hoist
//   - happy-dom does not hoist
//   - jsdom (parse5) hoists, exactly as Chrome does
// So a version of this file in either other environment passes whether or not the bug is fixed.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as FliptClient from '~/server/flipt/client';
import { createBlurbInputSchema } from '~/server/schema/blurb.schema';
import { BLURB_INTERIOR_ALLOWED_TAGS } from '~/utils/html-sanitize-helpers';

const { isFlipt } = vi.hoisted(() => ({ isFlipt: vi.fn() }));
const adapter = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt,
}));
vi.mock('~/server/services/blurb-fanout.adapters', () => ({
  getBlurbFanoutAdapter: () => adapter,
}));

const { expandBlurbs } = await import('~/server/services/blurb-materialize.service');
const { processBlurbEntity } = await import('~/server/services/blurb-fanout.service');

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
    ['a bullet list', '<ul><li>one</li><li>two</li></ul>', 'one<br />two'],
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

  it('turns block boundaries into line breaks rather than running the words together', () => {
    // Without the preprocess this is `firstsecond` — two sentences silently joined.
    expect(store('<p>first</p><p>second</p>')).toBe('first<br />second');
    expect(store('<pre><code>a</code></pre><p>b</p>')).toBe('<code>a</code><br />b');
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

// The row this guards against: `blurbContentSchema` cannot have sanitized it, because it never
// went through the API. A backfill, an admin script, or a row predating the inline-only rule.
const LEGACY_ROW = { id: 7, contentHash: 'h7', content: '<p>legacy body</p>' };
const HOST = '<p>before <span data-type="blurb" data-id="7">stale</span> after</p>';

describe('a stored block tag never reaches an entity body', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isFlipt.mockResolvedValue(true);
    dbMock.dbRead.blurb.findMany.mockResolvedValue([LEGACY_ROW]);
    adapter.load.mockResolvedValue({ userId: 10, html: HOST });
  });

  it('sanitizes it on the SAVE path', async () => {
    const result = await expandBlurbs({ userId: 10, html: HOST });
    if (!result.evaluated) throw new Error('expected the flag to be on');

    expect(result.html).toBe(
      '<p>before <span data-type="blurb" data-id="7">legacy body</span> after</p>'
    );
    expect(blurbSpanText(reparse(result.html))).toBe('legacy body');
  });

  it('sanitizes it on the FAN-OUT path', async () => {
    // Both paths reach the same splice, which is where the sanitize lives — enforcing it at the
    // two callers instead is what would let them drift.
    await processBlurbEntity([
      {
        blurbId: 7,
        entityType: 'Article',
        entityId: 1,
        materializedHash: 'old',
        ...LEGACY_ROW,
        deletedAt: null,
      },
    ]);

    const [saved] = adapter.save.mock.calls[0];
    expect(saved.html).toBe(
      '<p>before <span data-type="blurb" data-id="7">legacy body</span> after</p>'
    );
    expect(blurbSpanText(reparse(saved.html))).toBe('legacy body');
  });
});
