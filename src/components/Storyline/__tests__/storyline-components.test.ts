// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import type * as Trpc from '~/utils/trpc';
import type * as StorylineData from '~/components/Storyline/storyline.data';
import type * as Notifications from '~/utils/notifications';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';
import { NsfwLevel } from '~/server/common/enums';

const { calls, addCollaborator, queueRows } = vi.hoisted(() => ({
  calls: [] as string[],
  addCollaborator: { fail: false },
  queueRows: { value: [] as unknown[] },
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'storyline.addCollaborator': {
      useMutation: () => ({
        mutateAsync: async (input: { storylineId: number; userId: number }) => {
          calls.push(`endorse:${input.storylineId}:${input.userId}`);
          if (addCollaborator.fail) throw new Error('blocked');
        },
      }),
    },
  }),
}));
vi.mock('~/components/Storyline/storyline.data', async (importOriginal) => ({
  ...(await importOriginal<typeof StorylineData>()),
  useStorylineQueue: () => ({
    unavailable: false,
    rows: queueRows.value,
    isLoading: false,
    isError: false,
    hasMore: false,
    isFetchingMore: false,
    loadMore: () => undefined,
  }),
  useActOnStorylineContinuation: () => ({
    act: async (input: { placementId: number; action: string }) => {
      calls.push(`${input.action}:${input.placementId}`);
    },
  }),
}));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof Notifications>()),
  showSuccessNotification: (input: { title: string }) => calls.push(`success:${input.title}`),
  showErrorNotification: (input: { title: string }) => calls.push(`error:${input.title}`),
}));

const { StorylineContinueForm } = await import(
  '~/components/Storyline/continue/StorylineContinueForm'
);
const { StorylineQueueList } = await import('~/components/Storyline/queue/StorylineQueueList');
const { StorylineContinuationQueue } = await import(
  '~/components/Storyline/queue/StorylineContinuationQueue'
);

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function render(element: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(React.createElement(MantineProvider, null, element));
  });
  return container;
}

function visibleText(el: Element) {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('style').forEach((node) => node.remove());
  return clone.textContent ?? '';
}

function button(el: Element, label: string) {
  const match = [...el.querySelectorAll('button')].filter(
    (node) => node.textContent?.trim() === label
  );
  expect(match, `exactly one "${label}" button`).toHaveLength(1);
  return match[0] as HTMLButtonElement;
}

beforeEach(() => {
  calls.length = 0;
  addCollaborator.fail = false;
  queueRows.value = [];
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

const owner = 1;
const contributor = 2;
const story = {
  title: 'The Patch',
  userId: owner,
  status: 'Ongoing' as const,
  maxNsfwLevel: NsfwLevel.PG13,
};
const posts = [
  { id: 10, title: 'After hours', nsfwLevel: NsfwLevel.X },
  { id: 11, title: 'The cat returns', nsfwLevel: NsfwLevel.PG },
];

function continueForm(overrides: Partial<React.ComponentProps<typeof StorylineContinueForm>> = {}) {
  return React.createElement(StorylineContinueForm, {
    viewerId: contributor,
    storyline: story,
    parentTitle: 'Framed in a thrift store',
    mode: 'review',
    price: 0,
    isCollaborator: false,
    posts,
    postId: null,
    onPostChange: () => undefined,
    onSubmit: () => calls.push('submit'),
    ...overrides,
  });
}

describe('StorylineContinueForm', () => {
  it('refuses a post above the ceiling before submit, and will not submit it', () => {
    const el = render(continueForm({ postId: 10 }));

    expect(visibleText(el)).toContain(
      'Cannot be submitted. Your post is rated X; this storyline accepts up to PG-13.'
    );
    expect(button(el, 'Submit').disabled).toBe(true);
  });

  it('lets a post under the ceiling through, free, with the 7-day expiry', () => {
    const el = render(continueForm({ postId: 11 }));
    const text = visibleText(el);

    expect(text).not.toContain('Cannot be submitted');
    expect(text).toContain('Free');
    expect(text).toContain('If they do not answer in 7 days it expires.');
    const submit = button(el, 'Submit');
    expect(submit.disabled).toBe(false);
    act(() => submit.click());
    expect(calls).toEqual(['submit']);
  });

  it('shows a non-zero price on the button and promises the refund', () => {
    const el = render(continueForm({ postId: 11, price: 50 }));

    expect(visibleText(el)).toContain(
      'If they do not answer in 7 days it expires and your 50 Buzz is refunded.'
    );
    expect(button(el, 'Submit for 50 Buzz').disabled).toBe(false);
  });

  it('says collaborators-only before any post is picked', () => {
    const el = render(continueForm({ mode: 'off' }));
    const text = visibleText(el);

    expect(text).toContain(
      'Only the creator’s endorsed collaborators can continue this storyline.'
    );
    expect(el.querySelectorAll('button')).toHaveLength(0);
  });

  it('reports what happened after submit', () => {
    const el = render(continueForm({ postId: 11, outcome: 'awaitingScan' }));

    expect(visibleText(el)).toContain(
      'Submitted. It reaches the creator once your post finishes being rated.'
    );
  });
});

const row = (id: number, placerId = 50) => ({
  id,
  amount: 0,
  createdAt: new Date(),
  expiresAt: null,
  placer: { id: placerId, username: `user${placerId}` },
  post: { id: 100 + id, title: `Continuation ${id}`, nsfwLevel: NsfwLevel.PG },
  parentPost: { id: 200, title: 'Chapter 4' },
  storyline: { id: 7, title: 'The Patch', maxNsfwLevel: NsfwLevel.PG13 },
});

describe('StorylineQueueList', () => {
  it('disables every action on every row while one is in flight', () => {
    const el = render(
      React.createElement(StorylineQueueList, {
        rows: [row(1), row(2)],
        hasMore: false,
        onLoadMore: () => undefined,
        onAct: () => undefined,
        busy: { id: 1, action: 'accept' },
      })
    );

    const actions = [...el.querySelectorAll('button')];
    expect(actions).toHaveLength(6);
    expect(actions.every((node) => node.disabled)).toBe(true);
  });

  it('marks a row whose rating is above its storyline ceiling and will not accept it', () => {
    const above = { ...row(3), post: { id: 103, title: 'Too far', nsfwLevel: NsfwLevel.R } };
    const el = render(
      React.createElement(StorylineQueueList, {
        rows: [above],
        hasMore: false,
        onLoadMore: () => undefined,
        onAct: () => undefined,
        busy: null,
      })
    );

    expect(visibleText(el)).toContain("Rated above this storyline's maximum of PG-13.");
    expect(button(el, 'Accept').disabled).toBe(true);
    expect(button(el, 'Decline').disabled).toBe(false);
  });
});

async function clickAndSettle(node: HTMLButtonElement) {
  await act(async () => {
    node.click();
  });
}

describe('StorylineContinuationQueue', () => {
  it('Endorse accepts the continuation first, then endorses its author', async () => {
    queueRows.value = [row(1, 50)];
    const el = render(React.createElement(StorylineContinuationQueue));

    await clickAndSettle(button(el, 'Endorse'));

    expect(calls).toEqual(['approve:1', 'endorse:7:50', 'success:Accepted and endorsed']);
  });

  it('says which half failed when the endorse is refused', async () => {
    queueRows.value = [row(1, 50)];
    addCollaborator.fail = true;
    const el = render(React.createElement(StorylineContinuationQueue));

    await clickAndSettle(button(el, 'Endorse'));

    expect(calls).toEqual(['approve:1', 'endorse:7:50', 'error:Accepted, but not endorsed']);
  });

  it('Accept and Decline map to the placement decisions and never endorse', async () => {
    queueRows.value = [row(1, 50), row(2, 51)];
    const el = render(React.createElement(StorylineContinuationQueue));

    const [accept] = [...el.querySelectorAll('button')].filter((n) => n.textContent === 'Accept');
    await clickAndSettle(accept as HTMLButtonElement);
    const declines = [...el.querySelectorAll('button')].filter((n) => n.textContent === 'Decline');
    await clickAndSettle(declines[1] as HTMLButtonElement);

    expect(calls).toEqual(['approve:1', 'success:Accepted', 'decline:2', 'success:Declined']);
  });
});
