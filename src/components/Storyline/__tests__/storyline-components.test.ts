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

const { calls, addCollaborator, approve, queueRows } = vi.hoisted(() => ({
  calls: [] as string[],
  addCollaborator: { fail: false },
  approve: { fail: false },
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
      if (approve.fail) throw new Error('refused');
    },
  }),
}));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof Notifications>()),
  showSuccessNotification: (input: { title: string }) => calls.push(`success:${input.title}`),
  showErrorNotification: (input: { title: string }) => calls.push(`error:${input.title}`),
}));
// The search index and avatar fetches are not what these tests are about.
vi.mock('~/components/Search/QuickSearchDropdown', () => ({
  QuickSearchDropdown: () => React.createElement('input', { 'aria-label': 'user search' }),
}));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: ({ userId }: { userId: number }) =>
    React.createElement('span', null, `user ${userId}`),
}));

const { StorylineContinueForm } = await import(
  '~/components/Storyline/continue/StorylineContinueForm'
);
const { StorylineSettingsForm } = await import(
  '~/components/Storyline/manage/StorylineSettingsForm'
);
const { StorylineCollaboratorsPanel } = await import(
  '~/components/Storyline/manage/StorylineCollaboratorsPanel'
);
const { STORYLINE_MAX_COLLABORATORS } = await import('~/shared/utils/storyline');
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
  approve.fail = false;
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
    closedReason: null,
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
    const el = render(continueForm({ closedReason: 'collaboratorsOnly' }));
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

describe('StorylineContinueForm copy', () => {
  it('names each refusal the server or the storyline gives', () => {
    expect(visibleText(render(continueForm({ viewerId: owner })))).toContain(
      'This is your storyline. Add your next chapter from the storyline page instead.'
    );
    act(() => root?.unmount());
    expect(
      visibleText(render(continueForm({ storyline: { ...story, status: 'Complete' } })))
    ).toContain('This storyline is complete and is not taking continuations.');
    act(() => root?.unmount());
    expect(visibleText(render(continueForm({ closedReason: 'closed' })))).toContain(
      'This storyline is not taking continuations right now.'
    );
  });

  it('does not offer a storyline of your own when there is no button for it', () => {
    const el = render(continueForm({ postId: 10 }));

    expect(visibleText(el)).not.toContain('start your own storyline');
    expect([...el.querySelectorAll('button')].map((node) => node.textContent)).not.toContain(
      'Start my own storyline'
    );
  });

  it('tells an endorsed collaborator they skip review', () => {
    const el = render(continueForm({ postId: 11, isCollaborator: true }));

    expect(visibleText(el)).toContain(
      'You are an endorsed collaborator, so it skips review and goes straight into the story.'
    );
    expect(visibleText(el)).not.toContain('Goes to the creator for review.');
  });

  it('says an approved continuation is in, and a pending one is waiting', () => {
    const approved = visibleText(render(continueForm({ postId: 11, outcome: 'approved' })));
    expect(approved).toContain('Added to the storyline.');
    expect(approved).not.toContain('waiting for the creator');
    act(() => root?.unmount());

    const pending = visibleText(render(continueForm({ postId: 11, outcome: 'pending' })));
    expect(pending).toContain('Submitted. It is waiting for the creator to review.');
    expect(pending).not.toContain('Added to the storyline.');
  });
});

describe('StorylineQueueList rows', () => {
  const list = (rows: ReturnType<typeof row>[]) =>
    render(
      React.createElement(StorylineQueueList, {
        rows,
        hasMore: false,
        onLoadMore: () => undefined,
        onAct: () => undefined,
        busy: null,
      })
    );

  it('will not endorse a row above the ceiling', () => {
    const el = list([{ ...row(3), post: { id: 103, title: 'Too far', nsfwLevel: NsfwLevel.R } }]);

    expect(button(el, 'Endorse').disabled).toBe(true);
  });

  it('cannot endorse a continuation whose author is gone', () => {
    const el = list([{ ...row(4), placer: null }]);

    expect(visibleText(el)).toContain('by Someone');
    expect(button(el, 'Endorse').disabled).toBe(true);
    expect(button(el, 'Accept').disabled).toBe(false);
  });

  it('does not treat an unrated post, or a row without a ceiling, as over the line', () => {
    const unrated = { ...row(5), post: { id: 105, title: 'Pending scan', nsfwLevel: 0 } };
    const noCeiling = {
      ...row(6),
      post: { id: 106, title: 'Unknown ceiling', nsfwLevel: NsfwLevel.XXX },
      storyline: { id: 7, title: 'The Patch' },
    };
    const el = list([unrated, noCeiling]);

    expect(visibleText(el)).toContain('Not rated yet');
    expect(visibleText(el)).not.toContain('Rated above');
    const accepts = [...el.querySelectorAll('button')].filter((n) => n.textContent === 'Accept');
    expect(accepts.map((node) => (node as HTMLButtonElement).disabled)).toEqual([false, false]);
  });
});

describe('StorylineContinuationQueue refusals', () => {
  it('does not endorse when the accept is refused, and frees the buttons', async () => {
    queueRows.value = [row(1, 50)];
    approve.fail = true;
    const el = render(React.createElement(StorylineContinuationQueue));

    await clickAndSettle(button(el, 'Endorse'));

    expect(calls).toEqual(['approve:1', "error:Couldn't do that"]);
    expect(button(el, 'Endorse').disabled).toBe(false);
  });
});

const settingsForm = (
  overrides: Partial<React.ComponentProps<typeof StorylineSettingsForm>> = {}
) =>
  React.createElement(StorylineSettingsForm, {
    status: 'Ongoing',
    maxNsfwLevel: NsfwLevel.PG13,
    whoCanContinue: 'Anyone',
    space: { setPrice: 100, price: 100, cap: 500 },
    onStatusChange: (status) => calls.push(`status:${status}`),
    onRatingChange: (level) => calls.push(`rating:${level}`),
    onWhoCanContinueChange: (value) => calls.push(`who:${value}`),
    onPriceChange: (price) => calls.push(`price:${price}`),
    ...overrides,
  });

/** A SegmentedControl option, found by its visible label inside the named control. */
function option(el: Element, control: string, label: string) {
  const root = el.querySelector(`[aria-label="${control}"]`);
  expect(root, `control "${control}"`).not.toBeNull();
  const labelEl = [...(root as Element).querySelectorAll('label')].find(
    (node) => node.textContent?.trim() === label
  );
  expect(labelEl, `option "${label}" in "${control}"`).toBeTruthy();
  const input = el.ownerDocument.getElementById((labelEl as HTMLLabelElement).htmlFor);
  expect(input, `input for "${label}"`).not.toBeNull();
  return input as HTMLInputElement;
}

describe('StorylineSettingsForm', () => {
  it('writes each setting through its own callback', () => {
    const el = render(settingsForm());

    act(() => option(el, 'Status', 'Complete').click());
    act(() => option(el, 'Who can continue', 'Only collaborators').click());
    act(() => option(el, 'Maximum rating', 'R').click());

    expect(calls).toEqual(['status:Complete', 'who:Collaborators', `rating:${NsfwLevel.R}`]);
  });

  it('locks who can continue while the storyline is complete', () => {
    const el = render(settingsForm({ status: 'Complete' }));

    expect(option(el, 'Who can continue', 'Only collaborators').disabled).toBe(true);
    expect(visibleText(el)).toContain(
      'Set the storyline back to Ongoing to accept continuations again.'
    );
  });

  it('offers the creator default only for a price of its own, and resets to null', () => {
    const own = render(settingsForm());
    act(() => button(own, 'Use my default').click());
    expect(calls).toEqual(['price:null']);
    act(() => root?.unmount());

    const inherited = render(settingsForm({ space: { setPrice: null, price: 0, cap: 500 } }));
    expect(visibleText(inherited)).not.toContain('Use my default');
  });

  it('disables the controls it cannot read yet', () => {
    const el = render(settingsForm({ whoCanContinue: null, space: null }));

    expect(option(el, 'Who can continue', 'Anyone, I review first').disabled).toBe(true);
    expect(option(el, 'Status', 'Complete').disabled).toBe(false);
  });
});

describe('StorylineCollaboratorsPanel', () => {
  const panel = (
    overrides: Partial<React.ComponentProps<typeof StorylineCollaboratorsPanel>> = {}
  ) =>
    render(
      React.createElement(StorylineCollaboratorsPanel, {
        ownerId: owner,
        collaborators: [{ id: 50, username: 'tehalex' }],
        canManage: true,
        onAdd: () => undefined,
        onRemove: (userId) => calls.push(`remove:${userId}`),
        ...overrides,
      })
    );

  it('removes a collaborator by id', () => {
    const el = panel();
    const remove = el.querySelector('[aria-label="Remove tehalex"]') as HTMLButtonElement | null;
    expect(remove).not.toBeNull();

    act(() => remove?.click());

    expect(calls).toEqual(['remove:50']);
  });

  it('stops endorsing at the cap', () => {
    const full = Array.from({ length: STORYLINE_MAX_COLLABORATORS }, (_, i) => ({
      id: 100 + i,
      username: `u${i}`,
    }));
    const el = panel({ collaborators: full });

    expect(visibleText(el)).toContain(
      `A storyline can have up to ${STORYLINE_MAX_COLLABORATORS} endorsed collaborators.`
    );
    expect(button(el, 'Endorse').disabled).toBe(true);
  });

  it('shows the list without controls to someone who cannot manage it', () => {
    const el = panel({ canManage: false });

    expect(visibleText(el)).toContain('user 50');
    expect(el.querySelector('[aria-label="user search"]')).toBeNull();
    expect(el.querySelector('[aria-label="Remove tehalex"]')).toBeNull();
  });
});
