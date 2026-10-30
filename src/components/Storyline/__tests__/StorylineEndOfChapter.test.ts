// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as QueriesModule from '~/components/Storyline/storyline.queries';
import type * as ImageGuardModule from '~/components/ImageGuard/ImageGuard2';
import type * as EdgeMediaModule from '~/components/EdgeMedia/EdgeMedia';
import type * as ImageHashModule from '~/components/ImageHash/ImageHash';
import type { StorylineChild } from '~/components/Storyline/storyline.queries';

const mocks = vi.hoisted(() => ({
  children: [] as StorylineChild[],
  isLoading: false,
  forkShares: { enough: false, total: 0, minChoices: 20, shares: {} as Record<number, number> } as
    | { enough: boolean; total: number; minChoices: number; shares: Record<number, number> }
    | undefined,
  safe: true,
  trackCreateClick: vi.fn(),
  trigger: vi.fn(),
  terms: null as null | {
    open: boolean;
    price: number;
    closedReason: 'closed' | 'collaboratorsOnly' | null;
  },
  openContinue: vi.fn(),
  currentUser: null as null | { id: number; isModerator?: boolean },
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.currentUser }));

vi.mock('~/components/Storyline/storyline.queries', async (importOriginal) => ({
  ...(await importOriginal<typeof QueriesModule>()),
  useStorylineChildren: () => ({
    data: mocks.isLoading ? undefined : mocks.children,
    isLoading: mocks.isLoading,
  }),
  useStorylineForkShares: () => ({ data: mocks.forkShares }),
  useStorylineContinueTerms: () => mocks.terms,
  useStorylineTracking: () => ({
    trackBranchChoice: vi.fn(),
    trackCreateClick: mocks.trackCreateClick,
  }),
}));
vi.mock('~/components/Storyline/storyline.data', () => ({
  useSetStorylineMainPath: () => ({ isPending: false, mutate: vi.fn() }),
}));
vi.mock('~/components/Dialog/dialogStore', () => ({ dialogStore: { trigger: mocks.trigger } }));
vi.mock('~/components/Storyline/continue/openStorylineContinueModal', () => ({
  openStorylineContinueModal: mocks.openContinue,
}));
// The guard and the media element need the session and the CDN; here the guard's verdict is a
// switch, and its toggle and the hash leave a marker.
vi.mock('~/components/ImageGuard/ImageGuard2', async (importOriginal) => {
  const { createElement: h } = await import('react');
  return {
    ...(await importOriginal<typeof ImageGuardModule>()),
    ImageGuard2: Object.assign(
      ({ children }: { children: (safe: boolean) => unknown }) => children(mocks.safe),
      { BlurToggle: () => h('button', { 'data-testid': 'blur-toggle' }) }
    ),
  };
});
vi.mock('~/components/ImageHash/ImageHash', async (importOriginal) => {
  const { createElement: h } = await import('react');
  return {
    ...(await importOriginal<typeof ImageHashModule>()),
    MediaHash: () => h('div', { 'data-testid': 'media-hash' }),
  };
});
vi.mock('~/components/EdgeMedia/EdgeMedia', async (importOriginal) => {
  const { createElement: h } = await import('react');
  return {
    ...(await importOriginal<typeof EdgeMediaModule>()),
    EdgeMedia: ({ src, ...props }: { src: string; 'data-testid'?: string }) =>
      h('img', { src, 'data-testid': props['data-testid'] }),
  };
});
vi.mock('~/components/Storyline/StorylineEarlyAccessModal', () => ({
  StorylineEarlyAccessModal: () => null,
}));

import { MantineProvider } from '@mantine/core';
import {
  StorylineContinueWithPost,
  StorylineEndOfChapter,
} from '~/components/Storyline/StorylineEndOfChapter';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function child(
  chapterId: number,
  rank: StorylineChild['rank'],
  title: string | null,
  depth = 4
): StorylineChild {
  return title === null
    ? { chapterId, depth, tombstone: 'removed', post: null, rank, createdAt: new Date(0) }
    : {
        chapterId,
        depth,
        tombstone: null,
        post: { id: chapterId * 10, title, userId: chapterId, username: `user${chapterId}` },
        rank,
        createdAt: new Date(0),
      };
}

let onContinue = vi.fn();
function render(props: { parentPostId?: number; isOwner?: boolean } = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(
      createElement(
        MantineProvider,
        { forceColorScheme: 'light' },
        createElement(StorylineEndOfChapter, {
          chapterId: 4,
          storylineId: 9,
          chapterDepth: 3,
          onContinue,
          ...props,
        })
      )
    );
  });
  return container;
}

const forks = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>('[data-testid="storyline-fork"]'),
];
const within = (el: HTMLElement, testId: string) =>
  el.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

describe('StorylineEndOfChapter', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mocks.isLoading = false;
    mocks.safe = true;
    mocks.currentUser = null;
    mocks.forkShares = { enough: false, total: 0, minChoices: 1, shares: {} };
    mocks.trackCreateClick.mockClear();
    mocks.trigger.mockClear();
    mocks.terms = null;
    onContinue = vi.fn();
  });

  it('names the chapter that ended, and leaves the storyline to the chip', () => {
    mocks.children = [child(5, 'canon', 'Kept')];
    // The chip above the card already names the storyline.
    const text = render().textContent;
    expect([text?.includes('End of chapter 4'), text?.includes('The Patch')]).toEqual([
      true,
      false,
    ]);
  });

  it('keeps the server order; only the first fork leads, with Read as its action', () => {
    mocks.children = [
      child(5, 'canon', 'The thrift store closes down'),
      child(6, 'endorsed', 'A museum buys the frame'),
      child(7, 'community', 'Video: the cat comes back'),
    ];
    const cards = forks(render());
    expect(cards.map((c) => c.dataset.rank)).toEqual(['canon', 'endorsed', 'community']);
    expect(cards.map((c) => !!within(c, 'storyline-read-next'))).toEqual([true, false, false]);
    expect(within(cards[0], 'storyline-read-next')?.textContent).toBe('Read chapter 5');

    act(() => within(cards[0], 'storyline-read-next')?.click());
    act(() => within(cards[1], 'storyline-fork-open')?.click());
    expect(onContinue.mock.calls.map(([c]) => c.chapterId)).toEqual([5, 6]);
  });

  it('keeps the server order even where it differs from rank order', () => {
    mocks.children = [
      child(7, 'community', 'Most read'),
      child(5, 'canon', 'Canon'),
      child(6, 'endorsed', 'Endorsed'),
    ];
    const cards = forks(render());
    expect(cards.map((c) => c.dataset.chapterId)).toEqual(['7', '5', '6']);
    expect(cards.map((c) => !!within(c, 'storyline-read-next'))).toEqual([true, false, false]);
  });

  it("shows each way's first image, and a placeholder where the read gave none", () => {
    const cover = {
      id: 501,
      url: 'cover-501',
      type: 'image' as const,
      width: 832,
      height: 1216,
      nsfwLevel: 1,
      hash: null,
      userId: 5,
    };
    mocks.children = [
      { ...child(5, 'canon', 'Kept'), firstImage: cover },
      { ...child(6, 'community', 'Other'), firstImage: null },
    ] as StorylineChild[];
    const [lead, other] = forks(render());
    expect([
      within(lead, 'storyline-chapter-image')?.getAttribute('src'),
      within(other, 'storyline-chapter-image'),
      within(other, 'blur-toggle'),
      !!within(other, 'storyline-chapter-image-empty'),
      // Capped on a phone so Read stays in the first screen.
      [...lead.querySelectorAll('*')].some((e) => e.classList.contains('max-h-[30vh]')),
    ]).toEqual(['cover-501', null, null, true, true]);
  });

  // A missing picture is not a hidden chapter: the gradient, never the stripes.
  it('draws a lead with no picture as the storyline gradient, short on a phone', () => {
    mocks.children = [{ ...child(5, 'canon', 'Kept'), firstImage: null }] as StorylineChild[];
    const lead = forks(render())[0];
    const empty = within(lead, 'storyline-chapter-image-empty');
    expect([
      !!empty,
      !!within(lead, 'storyline-chapter-image-hidden'),
      empty?.classList.contains('aspect-video'),
      empty?.classList.contains('@md:aspect-[4/5]'),
    ]).toEqual([true, false, true, true]);
  });

  // Numbered on from the chapter that ends here (chapter 4), not by the ways' own depth, which for
  // a chapter where branches rejoin is its distance along another branch.
  it('names each way with its title and who wrote which chapter', () => {
    mocks.children = [child(5, 'canon', 'The thrift store', 5), child(6, 'community', null, 5)];
    const [lead, other] = forks(render());
    expect([
      within(lead, 'storyline-fork-name')?.textContent,
      within(lead, 'storyline-fork-byline')?.textContent,
      within(lead, 'storyline-read-next')?.textContent,
      within(other, 'storyline-fork-byline')?.textContent,
    ]).toEqual(['The thrift store', 'Chapter 5 by user5', 'Read chapter 5', 'Chapter 5']);
  });

  // An untitled chapter is named "Chapter N", so its byline does not say the number twice.
  it('drops the chapter number from the byline of an untitled chapter', () => {
    mocks.children = [child(5, 'canon', '', 5)];
    const lead = forks(render())[0];
    expect([
      within(lead, 'storyline-fork-name')?.textContent,
      within(lead, 'storyline-fork-byline')?.textContent,
    ]).toEqual(['Chapter 5', 'by user5']);
  });

  it('counts the other paths, and has no such header when there is only one way', () => {
    mocks.children = [
      child(5, 'canon', 'A'),
      child(6, 'community', 'B'),
      child(7, 'community', 'C'),
    ];
    expect(render().textContent).toContain('Other paths2');
    document.body.innerHTML = '';
    mocks.children = [child(5, 'canon', 'A')];
    expect(render().textContent).not.toContain('Other paths');
  });

  it('leads with a hidden way as a labelled placeholder the reader can still step past', () => {
    mocks.children = [child(5, 'canon', null), child(6, 'community', 'B')];
    const lead = forks(render())[0];
    expect([
      within(lead, 'storyline-read-next'),
      within(lead, 'storyline-chapter-image-hidden-label')?.textContent,
      within(lead, 'storyline-rank-chip')?.textContent,
    ]).toEqual([null, 'This chapter was removed', 'Canon']);
    act(() => within(lead, 'storyline-fork-open')?.click());
    expect(onContinue.mock.calls.map(([c]) => c.chapterId)).toEqual([5]);
  });

  it('blurs a cover the guard holds back, and keeps its toggle', () => {
    mocks.safe = false;
    mocks.children = [
      {
        ...child(5, 'canon', 'Kept'),
        firstImage: {
          id: 501,
          url: 'cover-501',
          type: 'image' as const,
          width: 832,
          height: 1216,
          nsfwLevel: 16,
          hash: 'LKO2?U%2Tw=w]~RBVZRi};RPxuwH',
          userId: 5,
        },
      },
    ] as StorylineChild[];
    const lead = forks(render())[0];
    expect([
      !!within(lead, 'storyline-chapter-image'),
      !!within(lead, 'media-hash'),
      !!within(lead, 'blur-toggle'),
    ]).toEqual([false, true, true]);
  });

  it('marks canon and endorsed ways, and nothing on a community one', () => {
    mocks.children = [
      child(5, 'canon', 'A'),
      child(6, 'endorsed', 'B'),
      child(7, 'community', 'C'),
    ];
    expect(
      forks(render()).map((c) => within(c, 'storyline-rank-chip')?.textContent ?? null)
    ).toEqual(['Canon', 'Endorsed', null]);
  });

  it('shows a hidden way as a placeholder that still lets the reader step past it', () => {
    mocks.children = [child(5, 'canon', 'Kept'), child(8, 'community', null)];
    const hidden = forks(render())[1];
    expect(hidden.textContent).toContain('This chapter was removed');
    expect(within(hidden, 'storyline-chapter-image-hidden')).not.toBeNull();
    act(() => within(hidden, 'storyline-fork-open')?.click());
    expect(onContinue.mock.calls.map(([c]) => c.chapterId)).toEqual([8]);
  });

  it('tags each fork with its chapter id and any tombstone, for the end-to-end spec', () => {
    mocks.children = [child(5, 'canon', 'Kept'), child(8, 'community', null)];
    expect(forks(render()).map((f) => [f.dataset.chapterId, f.dataset.tombstone])).toEqual([
      ['5', undefined],
      ['8', 'removed'],
    ]);
  });

  // The UI shows the shares it is given and does not gate on `enough`; the server withholds them
  // below `minChoices` (default 1: from the first choice).
  it('shows each way share from the first choice, with the readers behind the lead', () => {
    mocks.children = [
      child(5, 'canon', 'Kept'),
      child(6, 'community', 'Other'),
      child(7, 'community', 'Untaken'),
    ];
    mocks.forkShares = {
      enough: false,
      total: 13,
      minChoices: 20,
      shares: { 5: 8 / 13, 6: 5 / 13 },
    };
    const cards = forks(render());
    expect(cards.map((c) => within(c, 'storyline-share-percent')?.textContent)).toEqual([
      '62%',
      '38%',
      '0%',
    ]);
    expect(within(cards[0], 'storyline-share-caption')?.textContent).toBe(
      'of readers went this way · 8 readers'
    );
  });

  it('says one reader, not one readers', () => {
    mocks.children = [child(5, 'canon', 'Kept')];
    mocks.forkShares = { enough: true, total: 1, minChoices: 1, shares: { 5: 1 } };
    const lead = forks(render())[0];
    expect([
      within(lead, 'storyline-share-percent')?.textContent,
      within(lead, 'storyline-share-caption')?.textContent,
    ]).toEqual(['100%', 'of readers went this way · 1 reader']);
  });

  it('invites the first choice when nobody has chosen, and shows no percentages', () => {
    mocks.children = [child(5, 'canon', 'Kept'), child(6, 'community', 'Other')];
    const container = render();
    expect(within(forks(container)[0], 'storyline-share-first')?.textContent).toBe(
      'Be the first to choose'
    );
    expect(container.textContent).not.toContain('%');
  });

  // "Be the first" is a claim about the count, so it waits for the count.
  it('says nothing about choices while the shares are not read yet', () => {
    mocks.children = [child(5, 'canon', 'Kept'), child(6, 'community', 'Other')];
    mocks.forkShares = undefined;
    const container = render();
    expect([
      container.querySelector('[data-testid="storyline-share-first"]'),
      container.textContent?.includes('%'),
    ]).toEqual([null, false]);
  });

  it('shows a skeleton of the lead while the ways on load', () => {
    mocks.isLoading = true;
    const container = render();
    expect([
      !!container.querySelector('[data-testid="storyline-end-skeleton"]'),
      forks(container).length,
      container.textContent?.includes('The story stops here'),
    ]).toEqual([true, 0, false]);
  });

  it('offers continuing with a post only when the chapter has a post', () => {
    mocks.children = [];
    mocks.terms = { open: true, price: 0, closedReason: null };
    const sel = '[data-testid="storyline-continue-with-post"]';
    expect(render({ parentPostId: 15 }).querySelector(sel)).not.toBeNull();
    document.body.innerHTML = '';
    expect(render({}).querySelector(sel)).toBeNull();
  });

  // The owner adds chapters directly; the continue terms answer them "closed", which would read
  // as the storyline being shut. Say nothing instead.
  it('says nothing about continuing to the storyline owner', () => {
    mocks.children = [];
    mocks.terms = { open: false, price: 0, closedReason: 'closed' };
    const container = render({ parentPostId: 15, isOwner: true });
    expect([
      container.querySelector('[data-testid="storyline-continue-closed"]'),
      container.querySelector('[data-testid="storyline-continue-with-post"]'),
      !!container.querySelector('[data-testid="storyline-write-next"]'),
    ]).toEqual([null, null, true]);
    document.body.innerHTML = '';
    expect(
      render({ parentPostId: 15 }).querySelector('[data-testid="storyline-continue-closed"]')
        ?.textContent
    ).toBe('Closed to new chapters');
  });

  // The owner adds a chapter they already made, or joins one that exists, through the picker,
  // parented on the chapter they are at the end of.
  it('offers the owner the picker, parented on this chapter, and nobody else', () => {
    mocks.children = [];
    mocks.terms = { open: true, price: 0, closedReason: null };
    const own = '[data-testid="storyline-add-own-chapter"]';
    const join = '[data-testid="storyline-join-existing-chapter"]';
    const owned = render({ parentPostId: 15, isOwner: true });
    const useOwn = owned.querySelector<HTMLButtonElement>(own);
    const rejoin = owned.querySelector<HTMLButtonElement>(join);
    expect([useOwn?.textContent, rejoin?.textContent]).toEqual([
      'or use a post you already made',
      'Join an existing chapter',
    ]);
    act(() => useOwn?.click());
    act(() => rejoin?.click());
    expect(mocks.openContinue.mock.calls).toEqual([
      [{ parentPostId: 15, parentChapterId: 4 }],
      [{ parentPostId: 15, parentChapterId: 4, mode: 'join' }],
    ]);
    document.body.innerHTML = '';
    const reader = render({ parentPostId: 15 });
    expect([own, join].map((sel) => reader.querySelector(sel))).toEqual([null, null]);
    document.body.innerHTML = '';
    const noPost = render({ isOwner: true });
    expect([own, join].map((sel) => noPost.querySelector(sel))).toEqual([null, null]);
  });

  it('offers a moderator joining for the owner, and keeps their own way of continuing', () => {
    mocks.children = [];
    mocks.terms = { open: true, price: 0, closedReason: null };
    mocks.currentUser = { id: 99, isModerator: true };
    mocks.openContinue.mockClear();
    const view = render({ parentPostId: 15 });
    expect(view.querySelector('[data-testid="storyline-add-own-chapter"]')).toBeNull();
    expect(view.querySelector('[data-testid="storyline-write-next-price"]')).not.toBeNull();
    const rejoin = view.querySelector<HTMLButtonElement>(
      '[data-testid="storyline-join-existing-chapter"]'
    );
    act(() => rejoin?.click());
    expect(mocks.openContinue.mock.calls).toEqual([
      [{ parentPostId: 15, parentChapterId: 4, mode: 'join' }],
    ]);
  });

  it('puts writing below every path, outside the cards', () => {
    mocks.children = [
      child(5, 'canon', 'A'),
      child(6, 'community', 'B'),
      child(7, 'community', 'C'),
    ];
    const container = render();
    const cards = forks(container);
    const create = container.querySelector('[data-testid="storyline-create-block"]');
    if (!create) throw new Error('no create block');
    const last = cards[cards.length - 1];
    expect([
      !!(last.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING),
      cards.some((c) => c.contains(create)),
    ]).toEqual([true, false]);
  });

  describe('writing the next chapter', () => {
    const write = (c: HTMLElement) =>
      c.querySelector<HTMLAnchorElement>('[data-testid="storyline-write-next"]');
    const waitlist = (c: HTMLElement) =>
      c.querySelector<HTMLButtonElement>('[data-testid="storyline-early-access-link"]');

    beforeEach(() => {
      mocks.children = [];
      mocks.openContinue.mockClear();
    });

    // The end of chapter 4 (depth 3) writes chapter 5; `n` only labels the page.
    it('leads with it, on the editor with the chapter it continues, and counts the click', () => {
      mocks.terms = { open: true, price: 0, closedReason: null };
      const container = render({ parentPostId: 15 });
      const button = write(container);
      expect(button?.textContent).toBe('Write the next chapter');
      expect(button?.getAttribute('href')).toBe('/posts/create?continues=4&n=5');
      expect(mocks.trackCreateClick).not.toHaveBeenCalled();
      act(() => button?.click());
      expect(mocks.trackCreateClick.mock.calls).toEqual([[{ chapterId: 4 }]]);
      expect(mocks.trigger).not.toHaveBeenCalled();
    });

    it('says what it costs before the reader starts', () => {
      mocks.terms = { open: true, price: 50, closedReason: null };
      const container = render({ parentPostId: 15 });
      expect(within(container, 'storyline-write-next-price')?.textContent).toBe(
        '50 Buzz when you publish'
      );
      document.body.innerHTML = '';
      mocks.terms = { open: true, price: 0, closedReason: null };
      expect(within(render({ parentPostId: 15 }), 'storyline-write-next-price')?.textContent).toBe(
        'Free to submit'
      );
    });

    it('is not offered where the terms are closed to the reader, who is told so', () => {
      mocks.terms = { open: false, price: 0, closedReason: 'collaboratorsOnly' };
      const container = render({ parentPostId: 15 });
      expect([
        write(container),
        within(container, 'storyline-continue-closed')?.textContent,
        !!waitlist(container),
      ]).toEqual([null, 'Collaborators only', true]);
    });

    it('waits for the terms before offering it, and needs a chapter with a post', () => {
      mocks.terms = null;
      expect(write(render({ parentPostId: 15 }))).toBeNull();
      document.body.innerHTML = '';
      mocks.terms = { open: true, price: 0, closedReason: null };
      expect(write(render({}))).toBeNull();
    });

    // The terms answer the owner "closed" for their own storyline; that is not theirs to be refused.
    it('is always offered to the storyline owner', () => {
      mocks.terms = { open: false, price: 0, closedReason: 'closed' };
      const container = render({ parentPostId: 15, isOwner: true });
      expect(write(container)?.getAttribute('href')).toBe('/posts/create?continues=4&n=5');
      expect(within(container, 'storyline-write-next-price')).toBeNull();
    });

    // A waitlist for a tool that is not built: it must not read as a way to write a chapter.
    it('keeps the early access waitlist as a small link that says what it is, and opens it', () => {
      mocks.terms = { open: true, price: 0, closedReason: null };
      const container = render({ parentPostId: 15 });
      expect(waitlist(container)?.textContent).toBe('Story tool coming soon · get early access');
      expect(container.textContent).not.toContain('Create the next section');
      act(() => waitlist(container)?.click());
      expect(mocks.trigger).toHaveBeenCalledWith(
        expect.objectContaining({ props: { chapterId: 4, storylineId: 9 } })
      );
      // Joining the list is not a click on writing a chapter.
      expect(mocks.trackCreateClick).not.toHaveBeenCalled();
    });

    it('keeps the waitlist where there is nothing to write on', () => {
      mocks.terms = null;
      expect(!!waitlist(render({}))).toBe(true);
    });
  });
});

describe('StorylineContinueWithPost', () => {
  function renderButton() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      createRoot(container).render(
        createElement(
          MantineProvider,
          { forceColorScheme: 'light' },
          createElement(StorylineContinueWithPost, { parentPostId: 15 })
        )
      );
    });
    return container;
  }
  const button = (c: HTMLElement) =>
    c.querySelector<HTMLButtonElement>('[data-testid="storyline-continue-with-post"]');
  const closed = (c: HTMLElement) =>
    c.querySelector('[data-testid="storyline-continue-closed"]')?.textContent ?? null;

  beforeEach(() => {
    document.body.innerHTML = '';
    mocks.openContinue.mockClear();
  });

  it('is a text link under the primary action that opens the flow for this chapter', () => {
    mocks.terms = { open: true, price: 50, closedReason: null };
    const c = renderButton();
    expect(button(c)?.textContent).toBe('or use a post you already made');
    act(() => button(c)?.click());
    expect(mocks.openContinue).toHaveBeenCalledWith({ parentPostId: 15 });
  });

  it('has no button and says why when the storyline is closed', () => {
    mocks.terms = { open: false, price: 0, closedReason: 'closed' };
    const c = renderButton();
    expect(button(c)).toBeNull();
    expect(closed(c)).toBe('Closed to new chapters');
  });

  it('has no button and says why when only collaborators may continue', () => {
    mocks.terms = { open: false, price: 0, closedReason: 'collaboratorsOnly' };
    const c = renderButton();
    expect(button(c)).toBeNull();
    expect(closed(c)).toBe('Collaborators only');
  });

  it('shows nothing while the terms cannot be read', () => {
    mocks.terms = null;
    const c = renderButton();
    expect([button(c), closed(c)]).toEqual([null, null]);
  });
});
