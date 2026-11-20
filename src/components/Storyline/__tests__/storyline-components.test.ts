// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NextRouterModule from 'next/router';
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

// The queue keeps its received/sent tab in the URL; these render it with no Next router mounted.
vi.mock('next/router', async (importOriginal) => ({
  ...(await importOriginal<typeof NextRouterModule>()),
  useRouter: () => ({ query: {}, replace: vi.fn() }),
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
// Network-bound: search index and avatar fetches.
vi.mock('~/components/Search/QuickSearchDropdown', () => ({
  QuickSearchDropdown: ({
    onItemSelected,
  }: {
    onItemSelected: (entity: string, item: { id: number; username: string }) => void;
  }) =>
    React.createElement(
      'div',
      { 'aria-label': 'user search' },
      React.createElement(
        'button',
        { type: 'button', onClick: () => onItemSelected('users', { id: 60, username: 'newbie' }) },
        'Pick user 60'
      )
    ),
}));
// The real guard needs the session providers. This one keeps its contract: unless told
// `explain={false}`, a hidden picture gets an explainer with a Show button.
vi.mock('~/components/ImageGuard/ImageGuard2', () => {
  const ImageGuard2 = ({
    explain = true,
    children,
  }: {
    explain?: boolean;
    children: (safe: boolean) => React.ReactNode;
  }) =>
    React.createElement(
      React.Fragment,
      null,
      children(false),
      explain ? React.createElement('button', { type: 'button' }, 'Show') : null
    );
  ImageGuard2.BlurToggle = function BlurToggle() {
    return null;
  };
  return { ImageGuard2 };
});
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: ({ userId, subText }: { userId: number; subText?: React.ReactNode }) =>
    React.createElement('span', null, `user ${userId}`, subText),
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
const { StorylineRatingInput } = await import(
  '~/components/Storyline/settings/StorylineRatingInput'
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
    parentName: 'Framed in a thrift store',
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

  it('reports what happened after submit', () => {
    const el = render(continueForm({ postId: 11, outcome: 'awaitingScan' }));

    expect(visibleText(el)).toContain(
      'It goes to the storyline owner once your post finishes being rated'
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
  storyline: { id: 7, title: 'The Patch', maxNsfwLevel: NsfwLevel.PG13, takenDown: false },
});

describe('StorylineContinueForm post picker', () => {
  const radios = (el: Element) => [...el.querySelectorAll('[role="radio"]')] as HTMLButtonElement[];

  it('offers each post as a radio named for the post, and picks the one clicked', () => {
    const picked: (number | null)[] = [];
    const el = render(continueForm({ postId: 11, onPostChange: (id) => picked.push(id) }));

    const group = el.querySelector('[role="radiogroup"]');
    expect(group?.getAttribute('aria-labelledby')).toBeTruthy();
    expect(
      el.querySelector(`#${CSS.escape(group?.getAttribute('aria-labelledby') ?? '')}`)?.textContent
    ).toBe('Your post');
    expect(
      radios(el).map((node) => [node.getAttribute('aria-label'), node.getAttribute('aria-checked')])
    ).toEqual([
      ["After hours, above this storyline's PG-13 limit", 'false'],
      ['The cat returns, rated PG', 'true'],
    ]);

    act(() => radios(el)[0].click());
    expect(picked).toEqual([10]);
  });

  it('keeps an above-ceiling post in the grid, marked with the storyline limit', () => {
    const el = render(continueForm());
    const [above, under] = radios(el);

    expect(visibleText(above)).toContain('Above PG-13');
    expect(visibleText(under)).not.toContain('Above');
  });

  it('does not mark an unrated post as above the ceiling', () => {
    const el = render(continueForm({ posts: [{ id: 12, title: null, nsfwLevel: 0 }] }));
    const [tile] = radios(el);

    expect(tile.getAttribute('aria-label')).toBe('Post 12, not rated yet');
    expect(visibleText(tile)).not.toContain('Above');
  });
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

  // Blocked is a moderation verdict on someone else's post: the owner is never shown it.
  it('marks a Blocked-level row unusable without naming Blocked, and will not accept it', () => {
    const blocked = {
      ...row(3),
      post: { id: 103, title: 'Gone', nsfwLevel: NsfwLevel.PG | NsfwLevel.Blocked },
    };
    const el = render(
      React.createElement(StorylineQueueList, {
        rows: [blocked],
        hasMore: false,
        onLoadMore: () => undefined,
        onAct: () => undefined,
        busy: null,
      })
    );

    expect(visibleText(el)).toContain("can't be used in a storyline");
    expect(visibleText(el)).not.toContain('Blocked');
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

    await clickAndSettle(button(el, 'Approve + invite'));

    expect(calls).toEqual(['approve:1', 'endorse:7:50', 'success:Accepted and endorsed']);
  });

  it('says which half failed when the endorse is refused', async () => {
    queueRows.value = [row(1, 50)];
    addCollaborator.fail = true;
    const el = render(React.createElement(StorylineContinuationQueue));

    await clickAndSettle(button(el, 'Approve + invite'));

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

  it('marks a row in a taken-down storyline and offers no answer to it', () => {
    const el = list([row(7), { ...row(8), storyline: { ...row(8).storyline, takenDown: true } }]);
    const [open, held] = [7, 8].map(
      (id) => el.querySelector(`[data-testid="storyline-queue-row-${id}"]`) as HTMLElement
    );

    expect(held.querySelector('[data-testid="storyline-queue-held-8"]')?.textContent).toContain(
      'once the takedown is lifted'
    );
    expect(
      ['Accept', 'Approve + invite', 'Decline'].map((name) => button(held, name).disabled)
    ).toEqual([true, true, true]);
    expect(open.querySelector('[data-testid="storyline-queue-held-7"]')).toBeNull();
    expect(
      ['Accept', 'Approve + invite', 'Decline'].map((name) => button(open, name).disabled)
    ).toEqual([false, false, false]);
  });

  it('will not endorse a row above the ceiling', () => {
    const el = list([{ ...row(3), post: { id: 103, title: 'Too far', nsfwLevel: NsfwLevel.R } }]);

    expect(button(el, 'Approve + invite').disabled).toBe(true);
  });

  it('cannot endorse a continuation whose author is gone', () => {
    const el = list([{ ...row(4), placer: null }]);

    expect(visibleText(el)).toContain('by Someone');
    expect(button(el, 'Approve + invite').disabled).toBe(true);
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

    await clickAndSettle(button(el, 'Approve + invite'));

    expect(calls).toEqual(['approve:1', "error:Couldn't do that"]);
    expect(button(el, 'Approve + invite').disabled).toBe(false);
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
    // A price save sends the space's mode back; none may be made while the storyline is closed.
    expect(visibleText(el)).not.toContain('Use my default');
    expect(visibleText(el)).toContain(
      'Set the storyline back to Ongoing to accept continuations again.'
    );
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
        pending: [],
        canEndorse: true,
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

  const users = (count: number, from = 100) =>
    Array.from({ length: count }, (_, i) => ({ id: from + i, username: `u${from + i}` }));
  const capMessage = `A storyline can have up to ${STORYLINE_MAX_COLLABORATORS} endorsed collaborators, invitations included.`;

  it.each([
    ['collaborators', users(STORYLINE_MAX_COLLABORATORS), []],
    ['collaborators and an open invitation', users(STORYLINE_MAX_COLLABORATORS - 1), users(1, 900)],
  ])('stops endorsing at the cap, counting %s', (_name, collaborators, pending) => {
    const el = panel({ collaborators, pending });
    act(() => button(el, 'Pick user 60').click());

    expect(visibleText(el)).toContain(capMessage);
    expect(button(el, 'Invite').disabled).toBe(true);
  });
});

describe('isStorylineNotAvailable', () => {
  it('treats only the not-available refusal as "not yet", never another refusal', async () => {
    const { isStorylineNotAvailable } = await import('~/components/Storyline/storyline.data');
    const { STORYLINE_REFUSALS } = await import('~/shared/utils/storyline-placement');

    expect(isStorylineNotAvailable({ message: STORYLINE_REFUSALS.notAvailable })).toBe(true);
    expect(isStorylineNotAvailable({ message: STORYLINE_REFUSALS.notOpen })).toBe(false);
    expect(isStorylineNotAvailable(null)).toBe(false);
  });
});

describe('StorylineRatingInput', () => {
  it('disables the ratings isAllowed refuses and leaves the rest', () => {
    const el = render(
      React.createElement(StorylineRatingInput, {
        value: NsfwLevel.R,
        onChange: () => undefined,
        isAllowed: (level) => level >= NsfwLevel.R,
      })
    );

    expect(option(el, 'Maximum rating', 'PG').disabled).toBe(true);
    expect(option(el, 'Maximum rating', 'PG-13').disabled).toBe(true);
    expect(option(el, 'Maximum rating', 'R').disabled).toBe(false);
    expect(option(el, 'Maximum rating', 'XXX').disabled).toBe(false);
  });
});
