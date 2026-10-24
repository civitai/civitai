import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as DialogStoreModule from '~/components/Dialog/dialogStore';
import type * as QueriesModule from '~/components/Storyline/storyline.queries';

const mocks = vi.hoisted(() => ({ track: vi.fn(), trigger: vi.fn(), openContinue: vi.fn() }));
vi.mock('~/components/Storyline/storyline.queries', async (importOriginal) => ({
  ...(await importOriginal<typeof QueriesModule>()),
  useStorylineChildren: () => ({ data: [], isLoading: false }),
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
