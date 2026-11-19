/**
 * An owner's empty storyline carries the widest action row the header has: "Write chapter 1",
 * "Use a post you've published", Follow, Manage and the menu. Beside it the title must keep room
 * for whole words. It once got what the row left over at desktop width and broke "Balloon" across
 * lines. Geometry tier: the layout is Tailwind's, which the component tier does not load.
 */
import { Container } from '@mantine/core';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderAtViewport, type Viewport } from '../../../test/geometry-setup';
import type * as TrpcMod from '~/utils/trpc';

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  return { ...(await importOriginal<typeof TrpcMod>()), trpc: makeTrpcProxy({}) };
});
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, username: 'owner', isModerator: false }),
}));

const { StorylineHeader } = await import('~/components/Storyline/StorylinePage');

const TITLE = 'Balloon Girl';
const emptyOwnedStoryline = {
  id: 2,
  title: TITLE,
  status: 'Ongoing',
  viewerRole: 'owner',
  chapterCount: 0,
  contributorCount: 0,
  coverImage: null,
  rootHiddenReason: null,
  maxNsfwLevel: 4,
} as never;

afterEach(() => cleanup());

/** How many line boxes each word of the title's text spans: 1 means the word is whole. */
function wordLineCounts(heading: HTMLElement) {
  const text = heading.firstChild as Text;
  const words: Array<[string, number]> = [];
  let from = 0;
  for (const word of TITLE.split(' ')) {
    const start = TITLE.indexOf(word, from);
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + word.length);
    words.push([word, new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size]);
    from = start + word.length;
  }
  return words;
}

describe("an owner's empty storyline header", () => {
  test.each<[string, Viewport]>([
    ['desktop', { width: 1280, height: 900 }],
    ['tablet', { width: 820, height: 1000 }],
    ['phone', { width: 390, height: 844 }],
  ])('keeps every word of the title whole at %s width', async (_name, viewport) => {
    await renderAtViewport(
      // The page's own container, so the header is as wide as it is on /storylines/<id>.
      <Container size="lg">
        <StorylineHeader
          storyline={emptyOwnedStoryline}
          startLink={null}
          lastPostId={null}
          terms={null}
        />
      </Container>,
      viewport
    );
    const heading = document.querySelector('h1') as HTMLElement;
    expect(heading.textContent).toBe(TITLE);
    // The row this is about is present: the widest one the header renders.
    expect(document.body.textContent).toContain('Write chapter 1');
    expect(document.body.textContent).toContain("Use a post you've published");

    expect(wordLineCounts(heading)).toEqual(TITLE.split(' ').map((w) => [w, 1]));
  });

  test.each<[string, Viewport]>([
    ['desktop', { width: 1280, height: 900 }],
    ['phone', { width: 390, height: 844 }],
  ])('shows every action label in full at %s width', async (_name, viewport) => {
    await renderAtViewport(
      <Container size="lg">
        <StorylineHeader
          storyline={emptyOwnedStoryline}
          startLink={null}
          lastPostId={null}
          terms={null}
        />
      </Container>,
      viewport
    );
    const labels = [...document.querySelectorAll('header .mantine-Button-label')] as HTMLElement[];
    expect(labels.map((l) => l.textContent)).toEqual(
      expect.arrayContaining(['Write chapter 1', "Use a post you've published"])
    );
    // A clipped label is wider than the box Mantine gives it.
    expect(labels.filter((l) => l.scrollWidth > l.clientWidth).map((l) => l.textContent)).toEqual(
      []
    );
  });
});
