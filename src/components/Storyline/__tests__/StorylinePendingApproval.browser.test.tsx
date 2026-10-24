import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcModule from '~/utils/trpc';

const mocks = vi.hoisted(() => ({ rows: [] as unknown[], refusal: null as string | null }));
// A real query over the rows, never stale unless asked, as the app's tRPC client defaults it.
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { useInfiniteQuery } = await import('@tanstack/react-query');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: (await import('../../../../test/trpcProxyStub')).makeTrpcProxy({
      'placement.getMyStorylineContinuations': {
        useInfiniteQuery: (_input: unknown, options: object) =>
          useInfiniteQuery({
            queryKey: ['mine'],
            initialPageParam: null,
            staleTime: Infinity,
            // The harness client drops unused queries at once; the app keeps them for minutes.
            gcTime: Infinity,
            ...options,
            queryFn: async () => {
              if (mocks.refusal) throw new Error(mocks.refusal);
              return { items: [...mocks.rows], nextCursor: null };
            },
          }),
      },
    }),
  };
});

import Router from 'next/router';
import { useState } from 'react';
import { STORYLINE_REFUSALS } from '~/shared/utils/storyline-placement';
import { StorylineContinuationQueue } from '~/components/Storyline/queue/StorylineContinuationQueue';
import { StorylineContinueForm } from '~/components/Storyline/continue/StorylineContinueForm';
import { StorylineSentList } from '~/components/Storyline/queue/StorylineSentList';
import { STORYLINE_QUEUE_SENT_URL } from '~/components/Placement/queue-routes';

/**
 * A tester continued a storyline, saw it go nowhere, and thought it had failed: it was waiting for
 * the owner. Submitting has to say so, and say where to find it again.
 */
const sentRow = (id: number, status: string, extra: object = {}) => ({
  id,
  status,
  amount: 0,
  awaitingReadiness: false,
  createdAt: new Date('2026-10-24'),
  expiresAt: null,
  postId: 900 + id,
  parentPostId: 557,
  ...extra,
});

describe('a continuation waiting for the owner', () => {
  afterEach(() => {
    mocks.rows = [];
    mocks.refusal = null;
    Object.assign(Router, { query: {} });
  });

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
    await expect.element(link).toHaveAttribute('href', STORYLINE_QUEUE_SENT_URL);
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

  test('the sent link lands on the Sent tab', async () => {
    mocks.rows = [sentRow(1, 'pending')];
    Object.assign(Router, {
      query: Object.fromEntries(new URL(STORYLINE_QUEUE_SENT_URL, 'https://x').searchParams),
    });
    renderWithProviders(<StorylineContinuationQueue />);
    await expect
      .element(page.getByTestId('storyline-sent-row'))
      .toHaveTextContent("Waiting for the owner's approval");
  });

  test('coming back to the list shows a continuation sent since it was last read', async () => {
    mocks.rows = [sentRow(1, 'approved')];
    function Revisit() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button onClick={() => setOpen((o) => !o)}>toggle</button>
          {open && <StorylineSentList />}
        </>
      );
    }
    renderWithProviders(<Revisit />);
    await expect.element(page.getByTestId('storyline-sent-row')).toHaveTextContent('Accepted');
    mocks.rows = [sentRow(2, 'pending'), sentRow(1, 'approved')];
    await page.getByRole('button', { name: 'toggle' }).click();
    await page.getByRole('button', { name: 'toggle' }).click();
    await expect
      .element(page.getByTestId('storyline-sent-row').nth(0))
      .toHaveTextContent("Waiting for the owner's approval");
  });

  test('with storylines off on the server, Sent says so instead of asking for a refresh', async () => {
    mocks.refusal = STORYLINE_REFUSALS.notAvailable;
    renderWithProviders(<StorylineSentList />);
    await expect
      .element(page.getByText('Storyline continuations are not available yet.'))
      .toBeInTheDocument();
  });
});
