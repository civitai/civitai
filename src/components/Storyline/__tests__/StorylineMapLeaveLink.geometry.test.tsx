/**
 * THE MAP'S "Leave the storyline" LINK, AT A PHONE AND A LAPTOP.
 *
 * The link sits under the map's two buttons. A long path (many stops) makes the list scroll; the
 * link must keep its full height while it does, and the text must sit inside its box with its
 * descenders. `geometry` and not `component`: the sheet's flex column and the shrink rules are
 * Tailwind utilities, absent in the `component` tier.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup } from 'vitest-browser-react';
import { box, PHONE_VIEWPORT, renderAtViewport } from '../../../../test/geometry-setup';
import type * as QueriesModule from '~/components/Storyline/storyline.queries';
import { StorylineMapControl } from '~/components/Storyline/StorylineMap';
import type { ActiveStorylineMode } from '~/components/Storyline/StorylineModeProvider';

const LAPTOP_VIEWPORT = { width: 1200, height: 700 } as const;

vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: () => ({ opened: false, onClose: vi.fn() }),
}));
vi.mock('~/components/Storyline/StorylineChapterImage', () => ({
  StorylineChapterImage: () => <span />,
}));
vi.mock('~/components/Storyline/storyline.queries', async (importOriginal) => ({
  ...(await importOriginal<typeof QueriesModule>()),
  useStorylinePathChildren: () => new Map(),
  useStorylineCanonAhead: () => ({
    ahead: [],
    childrenByChapterId: new Map(),
    isLoading: false,
  }),
  useStorylineForkShares: () => ({ data: undefined }),
}));

const chapters = Array.from({ length: 24 }, (_, i) => ({
  chapterId: i + 1,
  depth: i,
  tombstone: null,
  post: { id: (i + 1) * 10, title: `Chapter ${i + 1}`, userId: 3, username: 'u' },
}));

const storyline = {
  active: true,
  path: { storyline: { id: 2, title: 'The Patch' }, chapters },
  drawerOpen: true,
  setDrawerOpen: vi.fn(),
  jumpToChapter: vi.fn(),
  continueTo: vi.fn(),
  leave: vi.fn(),
  chapterIdOfImage: () => 1,
} as unknown as ActiveStorylineMode;

afterEach(() => cleanup());

/** The link's box, and the box of its text: the text must sit wholly inside the link. */
async function measure(viewport: { readonly width: number; readonly height: number }) {
  const { observed } = await renderAtViewport(
    <StorylineMapControl storyline={storyline} currentChapterId={12} depth={11} />,
    viewport
  );
  const link = page.getByTestId('storyline-leave');
  await expect.element(link).toBeVisible();
  const el = link.element() as HTMLElement;
  const label = el.querySelector<HTMLElement>('.mantine-Button-label') ?? el;
  const range = document.createRange();
  range.selectNodeContents(label);
  const text = range.getBoundingClientRect();
  const frame = box(el);
  // Clipped by the button's own overflow, or by an ancestor that cuts it off.
  let clipper: Element | null = el.parentElement;
  const cuts: { bottom: number }[] = [];
  while (clipper && clipper !== document.body) {
    if (getComputedStyle(clipper).overflowY !== 'visible') cuts.push(box(clipper));
    clipper = clipper.parentElement;
  }
  return { observed, frame, text, cuts, label };
}

describe("the map's leave link", () => {
  test.each([
    ['390 phone', PHONE_VIEWPORT],
    ['1200 laptop', LAPTOP_VIEWPORT],
  ])('shows its whole line of text at %s', async (_name, viewport) => {
    const { observed, frame, text, cuts, label } = await measure(viewport);
    expect(observed).toEqual({ width: viewport.width, height: viewport.height });
    // The text's box lies inside the link's box.
    expect(text.top).toBeGreaterThanOrEqual(frame.top - 0.5);
    expect(text.bottom).toBeLessThanOrEqual(frame.bottom + 0.5);
    // Nothing in the label is cut: its content is no taller than the label.
    expect(label.scrollHeight).toBeLessThanOrEqual(label.clientHeight + 1);
    // And no scrolling or clipping ancestor ends above the link's bottom.
    for (const cut of cuts) expect(cut.bottom).toBeGreaterThanOrEqual(frame.bottom - 0.5);
    // A line of text needs at least its font size.
    expect(frame.height).toBeGreaterThanOrEqual(parseFloat(getComputedStyle(label).fontSize));
  });
});
