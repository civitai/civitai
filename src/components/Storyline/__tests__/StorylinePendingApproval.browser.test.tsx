import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcModule from '~/utils/trpc';

const mocks = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: (await import('../../../../test/trpcProxyStub')).makeTrpcProxy({
    'placement.getMyStorylineContinuations': {
      useInfiniteQuery: () => ({
        data: { pages: [{ items: mocks.rows, nextCursor: null }] },
        isLoading: false,
        isError: false,
        hasNextPage: false,
      }),
    },
  }),
}));

import { StorylineContinueForm } from '~/components/Storyline/continue/StorylineContinueForm';
import { StorylineSentList } from '~/components/Storyline/queue/StorylineSentList';
import { STORYLINE_SENT_URL } from '~/components/Storyline/storyline-routes';

/**
 * A tester continued a storyline, saw it go nowhere, and thought it had failed: it was waiting for
 * the owner. Submitting has to say so, and say where to find it again.
 */
describe('a continuation waiting for the owner', () => {
  test('the continue dialog says it waits for approval and links to the sent list', async () => {
    const onLeave = vi.fn();
    renderWithProviders(
      <StorylineContinueForm
        viewerId={2}
        storyline={{ title: 'Who', userId: 1, status: 'Ongoing', maxNsfwLevel: 1 }}
        parentName="B6: A Draw"
        closedReason={null}
        price={50}
        isCollaborator={false}
        posts={[]}
        postId={null}
        onPostChange={() => undefined}
        onSubmit={() => undefined}
        outcome="pending"
        onLeave={onLeave}
      />
    );
    const alert = page.getByTestId('storyline-submitted-pending');
    await expect.element(alert).toHaveTextContent('Submitted, waiting for approval');
    await expect.element(alert).toHaveTextContent("waiting for the storyline owner's approval");
    const link = page.getByRole('link', { name: 'See your sent continuations' });
    await expect.element(link).toHaveAttribute('href', STORYLINE_SENT_URL);
    document.addEventListener('click', (e) => e.preventDefault(), { once: true, capture: true });
    await link.click();
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  test('the sent list shows each continuation and where it stands', async () => {
    const sent = { amount: 0, createdAt: new Date('2026-10-24'), parentPostId: 557 };
    mocks.rows = [
      {
        ...sent,
        id: 1,
        status: 'pending',
        awaitingReadiness: false,
        postId: 901,
        expiresAt: new Date('2026-10-31'),
      },
      { ...sent, id: 2, status: 'pending', awaitingReadiness: true, postId: 902, expiresAt: null },
      {
        ...sent,
        id: 3,
        status: 'approved',
        awaitingReadiness: false,
        postId: 903,
        expiresAt: null,
      },
    ];
    renderWithProviders(<StorylineSentList />);
    const rows = page.getByTestId('storyline-sent-row');
    await expect.element(rows.nth(0)).toHaveTextContent("Waiting for the owner's approval");
    await expect.element(rows.nth(0)).toHaveTextContent('expires');
    await expect.element(rows.nth(1)).toHaveTextContent('Waiting for your post to finish rating');
    await expect.element(rows.nth(2)).toHaveTextContent('Accepted, in the story');
    await expect
      .element(rows.nth(0).getByRole('link', { name: 'Your post' }))
      .toHaveAttribute('href', '/posts/901');
    await expect
      .element(rows.nth(0).getByRole('link', { name: 'this chapter' }))
      .toHaveAttribute('href', '/posts/557');
  });
});
