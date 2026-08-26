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
// Both exports, not just the one these tests reach. `blurb-fanout.service` imports
// `getSupportedBlurbEntityTypes` too, and a hand-listed factory that omits it works only while
// nothing evaluates it — move that call to module scope and this file collects ZERO tests while
// still reporting green.
vi.mock('~/server/services/blurb-fanout.adapters', () => ({
  getBlurbFanoutAdapter: () => adapter,
  getSupportedBlurbEntityTypes: () => ['Article'],
}));

const { expandBlurbs } = await import('~/server/services/blurb-materialize.service');
const { processBlurbEntity } = await import('~/server/services/blurb-fanout.service');

const store = (content: string) => createBlurbInputSchema.parse({ name: 'n', content }).content;

/** What the article body looks like once `replaceBlurbSpans` has spliced a blurb into it. */
const splicedIntoArticle = (blurbContent: string) =>
  `<p>before</p><div data-type="blurb" data-id="7">${blurbContent}</div><p>after</p>`;

/** The browser's own parse of that body — what the editor sees when it reopens the article. */
const reparse = (html: string) => {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
};

const blurbInterior = (host: HTMLElement) =>
  host.querySelector('[data-type="blurb"]')?.innerHTML ?? null;

describe('blurb content keeps the blocks the editor offers', () => {
  it.each([
    ['a paragraph', '<p>blurb text</p>'],
    ['a bullet list', '<ul><li>one</li><li>two</li></ul>'],
    ['a numbered list', '<ol><li>one</li></ol>'],
    ['a heading', '<h2>shouty</h2>'],
  ])('keeps %s at save', (_label, input) => {
    expect(store(input)).toBe(input);
  });

  it('keeps the inline formatting the toolbar can produce', () => {
    expect(store('<p><strong>bold</strong> and <em>italic</em> and <code>code</code></p>')).toBe(
      '<p><strong>bold</strong> and <em>italic</em> and <code>code</code></p>'
    );
  });

  it('keeps a text colour, and only the colour', () => {
    expect(store('<p><span style="color: #fa5252">red</span></p>')).toBe(
      '<p><span style="color:#fa5252">red</span></p>'
    );
    // `style` is the one attribute a span may carry, so the tag cannot smuggle a marker in.
    expect(store('<p><span data-type="sticker" data-id="3">x</span></p>')).toBe(
      '<p><span>x</span></p>'
    );
    expect(store('<p><span style="position: fixed; color: red">x</span></p>')).toBe(
      '<p><span style="color:red">x</span></p>'
    );
  });

  it('keeps blocks separate rather than running the words together', () => {
    expect(store('<p>first</p><p>second</p>')).toBe('<p>first</p><p>second</p>');
    expect(reparse(store('<p>first</p><p>second</p>')).textContent).toBe('firstsecond');
    expect(reparse(store('<p>first</p><p>second</p>')).querySelectorAll('p')).toHaveLength(2);
  });

  it.each([
    ['a nested blurb', '<div data-type="blurb" data-id="99">theirs</div>', 'theirs'],
    ['a bare div', '<div>boxed</div>', 'boxed'],
    ['a blockquote', '<blockquote>quoted</blockquote>', 'quoted'],
    ['a code block', '<pre><code>x = 1</code></pre>', '<code>x = 1</code>'],
  ])('still strips %s, keeping its text', (_label, input, expected) => {
    expect(store(input)).toBe(expected);
  });

  it('🔴 allows no div, which is the blurb wrapper itself', () => {
    // A div here is found by `findBlurbSpans` as a blurb in its own right, so one carrying a
    // `data-id` would have the fan-out maintaining someone else's row inside this body.
    expect(BLURB_INTERIOR_ALLOWED_TAGS).not.toContain('div');
  });
});

describe('a spliced blurb survives the browser re-parse', () => {
  it('keeps a heading and a list inside the blurb', () => {
    const stored = store('<h2>Terms</h2><ul><li>one</li><li>two</li></ul>');
    const host = reparse(splicedIntoArticle(stored));

    expect(blurbInterior(host)).toBe('<h2>Terms</h2><ul><li>one</li><li>two</li></ul>');
    // Still inside the blurb, not hoisted out to a sibling.
    expect(host.querySelector('h2')?.closest('[data-type="blurb"]')).not.toBeNull();
    expect(host.querySelector('ul')?.closest('[data-type="blurb"]')).not.toBeNull();
  });

  it('keeps inline formatting and colour inside the blurb', () => {
    const host = reparse(
      splicedIntoArticle(store('<p><strong>bold</strong> <span style="color: red">red</span></p>'))
    );

    expect(blurbInterior(host)).toBe(
      '<p><strong>bold</strong> <span style="color:red">red</span></p>'
    );
  });

  it('🔴 EMPTIES an INLINE span holding the same content — why the wrapper is a div', () => {
    // The regression the block conversion fixed, kept as the witness for it. Put this content in
    // a `<span>` inside the host's `<p>` and the parser closes that paragraph on the block start
    // tag and pops the span rather than reconstructing it: an empty chip, the words hoisted into
    // a sibling, and — because `expandBlurbs` re-splices into the now-empty span on the author's
    // next save — the words twice.
    const host = reparse(
      '<p>before <span data-type="blurb" data-id="7"><h2>Terms</h2></span> after</p>'
    );

    expect(blurbInterior(host)).toBe('');
    expect(host.querySelector('h2')?.closest('[data-type="blurb"]')).toBeNull();
    expect(host.textContent).toContain('Terms');
  });
});

// The row this guards against: `blurbContentSchema` cannot have sanitized it, because it never
// went through the API. A backfill, an admin script, or a row predating the current allowlist.
const LEGACY_ROW = {
  id: 7,
  contentHash: 'h7',
  content: '<div data-type="blurb" data-id="99">legacy body</div>',
};
const HOST = '<p>before</p><div data-type="blurb" data-id="7">stale</div><p>after</p>';

describe('a stored nested blurb never reaches an entity body', () => {
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
      '<p>before</p><div data-type="blurb" data-id="7">legacy body</div><p>after</p>'
    );
    expect(reparse(result.html).querySelectorAll('[data-type="blurb"]')).toHaveLength(1);
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
      '<p>before</p><div data-type="blurb" data-id="7">legacy body</div><p>after</p>'
    );
    expect(reparse(saved.html).querySelectorAll('[data-type="blurb"]')).toHaveLength(1);
  });
});
