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

  it('says what is being continued, after which chapter, and on what terms', () => {
    const text = visibleText(render(continueForm({ price: 50 })));

    expect(text).toContain('Continue The Patch');
    expect(text).toContain('after Framed in a thrift store');
    expect(text).toContain('Up to PG-13');
    expect(text).toContain('50 Buzz to continue');
    act(() => root?.unmount());
    expect(visibleText(render(continueForm()))).toContain('Free to continue');
  });

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

  it('names an untitled post by its date', () => {
    const el = render(
      continueForm({
        posts: [
          { id: 13, title: null, nsfwLevel: NsfwLevel.PG, publishedAt: new Date(2026, 9, 3) },
        ],
      })
    );

    expect(radios(el)[0].getAttribute('aria-label')).toBe('Oct 3, 2026, rated PG');
  });

  it('counts the images of each post beside its name', () => {
    const el = render(
      continueForm({
        posts: [
          { id: 14, title: 'Many', nsfwLevel: NsfwLevel.PG, imageCount: 15 },
          { id: 15, title: 'One', nsfwLevel: NsfwLevel.PG, imageCount: 1 },
        ],
      })
    );

    expect(
      radios(el).map(
        (node) =>
          node.querySelector('[data-testid="storyline-post-image-count"]')?.textContent ?? null
      )
    ).toEqual(['15 images', '1 image']);
    act(() => root?.unmount());
    const uncounted = render(continueForm());
    expect(uncounted.querySelector('[data-testid="storyline-post-image-count"]')).toBeNull();
  });

  it('puts no control inside a tile, even over a blurred picture', () => {
    const cover = { id: 99, url: 'x', type: 'image' as const, nsfwLevel: NsfwLevel.X, hash: null };
    const el = render(
      continueForm({ posts: [{ id: 16, title: 'Blurred', nsfwLevel: NsfwLevel.PG, cover }] })
    );

    const [tile] = radios(el);
    expect(tile.querySelectorAll('button, a, input')).toHaveLength(0);
  });

  it('says the posts could not load instead of claiming there are none', () => {
    const text = visibleText(render(continueForm({ posts: [], postsError: true })));

    expect(text).toContain("Couldn't load your posts.");
    expect(text).not.toContain('You have no published posts');
  });

  it('counts the posts left out for being chapters already', () => {
    expect(visibleText(render(continueForm({ alreadyChapters: 3 })))).toContain(
      '3 of your posts are already chapters, so they aren’t listed.'
    );
    act(() => root?.unmount());
    expect(visibleText(render(continueForm({ alreadyChapters: 1 })))).toContain(
      '1 of your posts is already a chapter, so it isn’t listed.'
    );
    act(() => root?.unmount());
    expect(visibleText(render(continueForm()))).not.toContain('listed.');
  });

  it('says every recent post is already a chapter when none is left', () => {
    const el = render(continueForm({ posts: [], alreadyChapters: 4 }));
    const text = visibleText(el);

    expect(text).toContain(
      'All your recent posts are already chapters. Make a new post to continue the story.'
    );
    expect(text).not.toContain('You have no published posts');
    expect(text).not.toContain('aren’t listed');
    expect([...el.querySelectorAll('a')].some((a) => a.textContent === 'Create a post')).toBe(true);
  });

  it('shows placeholder tiles while posts load, and a way to make one when there are none', () => {
    const loading = render(continueForm({ posts: [], postsLoading: true, cover: null }));
    expect(loading.querySelectorAll('.mantine-Skeleton-root')).toHaveLength(6);
    expect(loading.querySelector('[role="radiogroup"]')).toBeNull();
    expect(visibleText(loading)).not.toContain('You have no published posts');
    act(() => root?.unmount());

    const empty = render(continueForm({ posts: [] }));
    expect(visibleText(empty)).toContain('You have no published posts.');
    const link = [...empty.querySelectorAll('a')].find((a) => a.textContent === 'Create a post');
    expect(link?.getAttribute('href')).toBe('/posts/create');
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
    expect(pending).toContain("It is waiting for the storyline owner's approval");
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

  it('shows the continuation cover, or says why there is none, and stays actionable', () => {
    const cover = { id: 9, url: 'u9', nsfwLevel: NsfwLevel.PG, hash: null };
    const el = list([
      { ...row(7), post: { ...row(7).post, coverImage: cover } },
      { ...row(8), post: { ...row(8).post, coverImage: null } },
    ]);
    const [withCover, withheld] = [7, 8].map(
      (id) => el.querySelector(`[data-testid="storyline-queue-row-${id}"]`) as HTMLElement
    );

    // The guard mock hides every picture; one with no hash fills its slot with stripes.
    expect(
      withCover.querySelector('[data-testid="storyline-chapter-image-blurred"]')
    ).not.toBeNull();
    expect(withCover.querySelector('[data-testid="storyline-chapter-image-hidden"]')).toBeNull();
    expect(
      withheld.querySelector('[data-testid="storyline-chapter-image-hidden-label"]')?.textContent
    ).toBe('Preview not available on this site');
    expect(button(withheld, 'Accept').disabled).toBe(false);
    expect(button(withheld, 'Approve + invite').disabled).toBe(false);
  });

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

  it('puts no control inside the cover and does not wrap it in a link', () => {
    const cover = {
      id: 9,
      url: 'u9',
      nsfwLevel: NsfwLevel.X,
      hash: 'LKO2?U%2Tw=w',
      width: 2,
      height: 3,
    };
    const el = list([{ ...row(7), post: { ...row(7).post, coverImage: cover } }]);
    const card = el.querySelector('[data-testid="storyline-queue-row-7"]') as HTMLElement;

    // Nothing from the guard's explainer.
    expect([...card.querySelectorAll('button')].map((node) => node.textContent)).toEqual([
      'Accept',
      'Approve + invite',
      'Decline',
    ]);
    // The title and the parent chapter; the cover is not a third link.
    expect(card.querySelectorAll('a')).toHaveLength(2);
  });

  it('fills a hidden cover with stripes whenever there is nothing to draw', () => {
    const covers = [
      { id: 1, url: 'u1', nsfwLevel: NsfwLevel.X, hash: 'LKO2?U%2Tw=w', width: null, height: 3 },
      { id: 2, url: 'u2', nsfwLevel: NsfwLevel.X, hash: 'LKO2?U%2Tw=w', width: 2, height: null },
    ];
    const el = list(
      covers.map((coverImage, i) => ({ ...row(i + 1), post: { ...row(i + 1).post, coverImage } }))
    );

    expect(el.querySelectorAll('[data-testid="storyline-chapter-image-blurred"]')).toHaveLength(2);
  });

  it('says there is no preview when the row carries no cover at all', () => {
    const el = list([row(5)]);

    expect(
      el.querySelector('[data-testid="storyline-chapter-image-hidden-label"]')?.textContent
    ).toBe('Preview not available on this site');
  });

  it('names an untitled continuation as a continuation by its author', () => {
    const el = list([{ ...row(9), post: { id: 109, title: null, nsfwLevel: NsfwLevel.PG } }]);

    expect(visibleText(el)).toContain('Continuation by user50');
    expect(visibleText(el)).not.toContain('Untitled post');
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

  it('offers the creator default only for a price of its own, and resets to null', () => {
    const own = render(settingsForm());
    act(() => button(own, 'Use my default').click());
    expect(calls).toEqual(['price:null']);
    act(() => root?.unmount());

    const inherited = render(settingsForm({ space: { setPrice: null, price: 0, cap: 500 } }));
    expect(visibleText(inherited)).not.toContain('Use my default');
  });

  it('warns that lowering the ceiling hides chapters, and that raising it brings them back', () => {
    const text = visibleText(render(settingsForm()));

    expect(text).toContain(
      'chapters rated above this are hidden from readers. Raising it again brings them back.'
    );
  });

  it('says how many chapters the current ceiling hides, and will not go below chapter 1', () => {
    const el = render(
      settingsForm({
        chapterLevels: {
          rootNsfwLevel: NsfwLevel.PG13,
          chapterLevels: [NsfwLevel.PG, NsfwLevel.R, NsfwLevel.X],
        },
      })
    );

    expect(visibleText(el)).toContain(
      '2 chapters are rated above this and are hidden from readers.'
    );
    expect(option(el, 'Maximum rating', 'PG').disabled).toBe(true);
    expect(option(el, 'Maximum rating', 'PG-13').disabled).toBe(false);
    expect(option(el, 'Maximum rating', 'XXX').disabled).toBe(false);
  });

  it('offers every rating and no count before the chapter ratings are read', () => {
    const el = render(settingsForm({ chapterLevels: null }));

    expect(visibleText(el)).not.toContain('rated above this and are hidden');
    expect(option(el, 'Maximum rating', 'PG').disabled).toBe(false);
  });

  it('shows no price slider while pricing is unavailable, and says the storyline is free', () => {
    const el = render(settingsForm({ priceUnavailable: true }));
    const text = visibleText(el);

    expect(el.querySelector('[role="slider"]')).toBeNull();
    expect(text).not.toContain('Free to continue');
    expect(text).toContain('The price is not available yet.');
    expect(text).not.toContain('Use my default');
    act(() => root?.unmount());

    const priced = render(settingsForm());
    expect(priced.querySelector('[role="slider"]')).not.toBeNull();
    expect(visibleText(priced)).not.toContain('The price is not available yet.');
  });

  it('puts the cover row first, before Status, only when given one', () => {
    const el = render(
      settingsForm({
        coverRow: React.createElement('span', { 'data-testid': 'cover-row' }, 'Cover'),
      })
    );
    const text = visibleText(el);

    expect(el.querySelector('[data-testid="cover-row"]')).not.toBeNull();
    expect(text.indexOf('Cover')).toBeLessThan(text.indexOf('Status'));
    act(() => root?.unmount());
    expect(visibleText(render(settingsForm())).startsWith('Status')).toBe(true);
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

  it('still endorses one below the cap', () => {
    const el = panel({ collaborators: users(STORYLINE_MAX_COLLABORATORS - 1) });
    act(() => button(el, 'Pick user 60').click());

    expect(visibleText(el)).not.toContain(capMessage);
    expect(button(el, 'Invite').disabled).toBe(false);
  });

  it('endorses the picked user below the cap, then clears the pick', () => {
    const added: number[] = [];
    const el = panel({ onAdd: (user) => added.push(user.id) });
    expect(button(el, 'Invite').disabled).toBe(true);

    act(() => button(el, 'Pick user 60').click());
    const endorse = button(el, 'Invite');
    expect(endorse.disabled).toBe(false);
    act(() => endorse.click());

    expect(added).toEqual([60]);
    expect(button(el, 'Invite').disabled).toBe(true);
    expect(el.querySelector('[aria-label="user search"]')).not.toBeNull();
  });

  it('marks each collaborator as endorsed, and says when there are none', () => {
    expect(visibleText(panel())).toContain('Endorsed');
    act(() => root?.unmount());
    const empty = visibleText(panel({ collaborators: [] }));
    expect(empty).toContain('No endorsed collaborators yet.');
    expect(empty).not.toContain('Endorsed');
  });

  it('offers a moderator removing but not endorsing', () => {
    const el = panel({ canEndorse: false });

    expect(visibleText(el)).toContain('user 50');
    expect(el.querySelector('[aria-label="user search"]')).toBeNull();
    expect(el.querySelector('[aria-label="Remove tehalex"]')).not.toBeNull();
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

  it('allows every rating without isAllowed', () => {
    const el = render(
      React.createElement(StorylineRatingInput, { value: NsfwLevel.PG, onChange: () => undefined })
    );

    expect(option(el, 'Maximum rating', 'PG').disabled).toBe(false);
  });
});
