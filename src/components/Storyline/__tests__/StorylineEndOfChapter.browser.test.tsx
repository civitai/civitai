import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as DialogStoreModule from '~/components/Dialog/dialogStore';
import type * as QueriesModule from '~/components/Storyline/storyline.queries';
import type * as IsMobileModule from '~/hooks/useIsMobile';

const mocks = vi.hoisted(() => ({
  track: vi.fn(),
  trigger: vi.fn(),
  openContinue: vi.fn(),
  children: [] as unknown[],
  narrow: false,
  touch: false,
}));
// The harness mounts no layout container, which is what picks the narrow stage.
vi.mock('~/hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<typeof IsMobileModule>()),
  useIsMobile: () => mocks.narrow,
  useHasCoarsePointer: () => mocks.touch,
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/components/Storyline/storyline.queries', async (importOriginal) => ({
  ...(await importOriginal<typeof QueriesModule>()),
  useStorylineChildren: () => ({ data: mocks.children, isLoading: false }),
  useStorylineForkShares: () => ({ data: { enough: true, total: 0, minChoices: 1, shares: {} } }),
  useStorylineContinueTerms: () => ({ open: true, price: 50, closedReason: null }),
  useStorylineTracking: () => ({ trackBranchChoice: vi.fn(), trackCreateClick: mocks.track }),
}));
vi.mock('~/components/Dialog/dialogStore', async (importOriginal) => ({
  ...(await importOriginal<typeof DialogStoreModule>()),
  dialogStore: { trigger: mocks.trigger },
}));
vi.mock('~/components/Storyline/continue/openStorylineContinueModal', () => ({
  openStorylineContinueModal: mocks.openContinue,
}));
import { StorylineEndOfChapter } from '~/components/Storyline/StorylineEndOfChapter';

/**
 * The three ways on from the end of a chapter, clicked in a real browser: the primary action
 * navigates to the editor and counts the click, the text link opens the existing-post flow, and the
 * waitlist link opens early access without counting as a chapter-writing click.
 */
describe('the end-of-chapter actions', () => {
  test('each does its own thing', async () => {
    renderWithProviders(
      <StorylineEndOfChapter
        chapterId={4}
        storylineId={9}
        chapterDepth={3}
        parentPostId={15}
        onContinue={() => undefined}
      />
    );
    const navigated: string[] = [];
    document.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a');
      if (a) {
        navigated.push(new URL(a.href).pathname + new URL(a.href).search);
        e.preventDefault();
      }
    });
    const primary = page.getByRole('link', { name: 'Write the next chapter' });
    await expect.element(primary).toHaveAttribute('href', '/posts/create?continues=4&n=5');
    await primary.click();
    expect(mocks.track).toHaveBeenCalledWith({ chapterId: 4 });
    expect(navigated).toEqual(['/posts/create?continues=4&n=5']);

    await page.getByRole('button', { name: 'or use a post you already made' }).click();
    expect(mocks.openContinue).toHaveBeenCalledWith({ parentPostId: 15 });

    await page.getByRole('button', { name: 'Story tool coming soon · get early access' }).click();
    expect(mocks.trigger).toHaveBeenCalledWith(
      expect.objectContaining({ props: { chapterId: 4, storylineId: 9 } })
    );
    expect(mocks.track).toHaveBeenCalledTimes(1);
  });
});

const child = (chapterId: number, extra = {}) => ({
  chapterId,
  depth: 5,
  rank: chapterId === 41 ? 'canon' : 'community',
  tombstone: null,
  post: { id: chapterId * 10, title: null, username: 'someone' },
  firstImage: null,
  ...extra,
});

/** → on the end card, the way the reader's overlay is used: only the card's own listener hears it. */
describe('→ at the end of a chapter', () => {
  beforeEach(() => {
    mocks.children = [child(41)];
    mocks.narrow = false;
    mocks.touch = false;
  });
  const renderEnd = (props: Record<string, unknown> = {}) => {
    const onContinue = vi.fn();
    renderWithProviders(
      <StorylineEndOfChapter
        chapterId={4}
        storylineId={9}
        chapterDepth={3}
        parentPostId={15}
        onContinue={onContinue}
        {...props}
      />
    );
    return onContinue;
  };
  const press = (key: string, init: KeyboardEventInit = {}) =>
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));

  test('with one way on, continues down it, and the button says so', async () => {
    const onContinue = renderEnd();
    await expect.element(page.getByTestId('storyline-read-next-hotkey')).toBeVisible();

    press('ArrowRight');
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onContinue).toHaveBeenCalledWith(expect.objectContaining({ chapterId: 41 }));
  });

  test('the reader behind it never hears the key', async () => {
    renderEnd();
    await expect.element(page.getByTestId('storyline-read-next-hotkey')).toBeVisible();
    const behind = vi.fn();
    document.addEventListener('keydown', behind, true);
    press('ArrowRight');
    document.removeEventListener('keydown', behind, true);
    expect(behind).not.toHaveBeenCalled();
  });

  test.each([
    ['several paths', () => (mocks.children = [child(41), child(42)])],
    ['a chapter hidden from this reader', () => (mocks.children = [child(41, { post: null })])],
    ['a narrow stage', () => (mocks.narrow = true)],
    ['a touch screen', () => (mocks.touch = true)],
  ])('does nothing with %s, and the button shows no hint', async (_label, setup) => {
    setup();
    const onContinue = renderEnd();
    await expect.element(page.getByTestId('storyline-end-of-chapter')).toBeVisible();

    press('ArrowRight');
    expect(onContinue).not.toHaveBeenCalled();
    expect(page.getByTestId('storyline-read-next-hotkey').elements()).toHaveLength(0);
  });

  test('ignores other keys, modified keys and typing in a field', async () => {
    const onContinue = renderEnd();
    await expect.element(page.getByTestId('storyline-read-next-hotkey')).toBeVisible();
    press('ArrowLeft');
    press('ArrowRight', { shiftKey: true });
    press('ArrowRight', { metaKey: true });
    const box = document.body.appendChild(document.createElement('textarea'));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    box.remove();
    expect(onContinue).not.toHaveBeenCalled();
  });

  test('in the page section it is not bound at all', async () => {
    const onContinue = renderEnd({ layout: 'section' });
    await expect.element(page.getByTestId('storyline-end-of-chapter')).toBeVisible();
    press('ArrowRight');
    expect(onContinue).not.toHaveBeenCalled();
  });
});
