// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BIRTHDAY_2026_PREVIEW_FROM } from '~/shared/constants/birthday2026.constants';
import type { NavBanner } from '~/shared/constants/nav-banner.constants';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Hat = {
  cosmeticId: number;
  claimKey: string;
  name: string;
  points: number;
  data: { event: string; type: string; url: string; team?: string };
  placedOn: { entityType: string; entityId: number } | null;
};

// `banners` stands in for the gated server answer this viewer gets; `hats` for their own hats.
const h = vi.hoisted(() => ({
  banners: [] as NavBanner[],
  hats: [] as Hat[],
  hatsInput: [] as unknown[],
  openPicker: vi.fn(),
  unequip: vi.fn(async () => ({ count: 1 })),
  invalidateHats: vi.fn(async () => undefined),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy(
    {
      'event.getNavBanners': { useQuery: () => ({ data: h.banners }) },
      'event.getMyHats': {
        useQuery: (input: unknown, opts?: { enabled?: boolean }) => {
          // A disabled query still answers from the cache, which another surface may have filled.
          if (opts?.enabled === false) return { data: h.hats, isLoading: false };
          h.hatsInput.push(input);
          return { data: h.hats, isLoading: false };
        },
      },
    },
    { useUtils: () => ({ event: { getMyHats: { invalidate: h.invalidateHats } } }) }
  ),
}));
vi.mock('~/components/Cosmetics/cosmetics.util', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useEquipContentDecoration: () => ({ equip: vi.fn(), unequip: h.unequip, isLoading: false }),
}));
vi.mock('~/components/Dialog/dialogStore', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createDialogTrigger: () => h.openPicker,
}));
vi.mock('cookies-next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  setCookie: vi.fn(),
}));
vi.mock('~/providers/AppProvider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMaybeAppContext: () => ({ navBannersDismissed: [] }),
}));
vi.mock('~/components/EdgeMedia/EdgeImage', () => ({ EdgeImage: () => null }));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({ EdgeMedia: () => null }));

const { ArticleEditEventCard } = await import('~/components/Article/ArticleEditEventCard');
const { PostEditEventCard } = await import('~/components/Post/EditV2/PostEditEventCard');

const EDITOR = { title: 'Civitai turns 4.', body: 'Put a party hat on this article.' };
const BIRTHDAY: NavBanner = {
  id: 'event:birthday2026',
  title: 'Civitai turns 4.',
  href: '/events/birthday2026',
  dismissible: true,
  priority: 0,
  promo: {
    event: 'birthday2026',
    menuLabel: "Civitai's 4th Birthday",
    menuIcon: 'confetti',
    teamHref: '/events/birthday2026/team',
    postEditor: { title: 'Civitai turns 4.', body: 'Put a party hat on an image in this post.' },
    articleEditor: { ...EDITOR, draftNote: 'Scores once it is published.' },
  },
};
const ARTICLE_ID = 7;
const COVER = {
  id: 42,
  url: 'img-42',
  width: 512,
  height: 512,
  name: null,
  type: 'image',
} as unknown as NonNullable<React.ComponentProps<typeof ArticleEditEventCard>['coverImage']>;
const hat = (cosmeticId: number, placedOn: Hat['placedOn'] = null): Hat => ({
  cosmeticId,
  claimKey: `k${cosmeticId}`,
  name: `Hat ${cosmeticId}`,
  points: 1240,
  data: { event: 'birthday2026', type: 'hat', url: `hat-${cosmeticId}`, team: 'Blue' },
  placedOn,
});
const PICKER_CALL = [
  {
    props: { entityType: 'Article', entityId: ARTICLE_ID, image: COVER, event: 'birthday2026' },
  },
];

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});
beforeEach(() => {
  h.banners = [];
  h.hats = [];
  h.hatsInput = [];
  h.openPicker.mockClear();
  h.unequip.mockClear();
  h.invalidateHats.mockClear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(BIRTHDAY_2026_PREVIEW_FROM.getTime() + 60 * 60 * 1000));
});
afterEach(() => vi.useRealTimers());

function render(node: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(React.createElement(MantineProvider, null, node)));
  return host;
}
const card = (props: Partial<React.ComponentProps<typeof ArticleEditEventCard>> = {}) =>
  render(
    React.createElement(ArticleEditEventCard, {
      articleId: ARTICLE_ID,
      coverImage: COVER,
      showDraftNote: false,
      ...props,
    })
  );
const text = (el: HTMLElement) => el.textContent ?? '';
const button = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll('button')].find((b) => text(b) === label);

describe('article editor event card', () => {
  it('is absent, and asks for no hats, when the gated answer has no promo for this viewer', () => {
    expect(card().querySelector('[data-testid="article-edit-event-card"]')).toBeNull();
    expect(h.hatsInput).toEqual([]);
  });

  it('is absent for an event with only post editor copy', () => {
    h.banners = [{ ...BIRTHDAY, promo: { ...BIRTHDAY.promo!, articleEditor: undefined } }];
    expect(card().querySelector('[data-testid="article-edit-event-card"]')).toBeNull();
  });

  it('offers to join a team to a viewer with no hats, opening the picker on the article', () => {
    h.banners = [BIRTHDAY];
    const el = card();
    expect(text(el)).toContain('Put a party hat on this article.');
    // Asked on each render, always for this event.
    expect(h.hatsInput.length).toBeGreaterThan(0);
    expect(h.hatsInput.filter((i) => JSON.stringify(i) !== '{"event":"birthday2026"}')).toEqual([]);
    expect(button(el, 'Put on a Party Hat')).toBeUndefined();
    act(() => button(el, 'Join a team')!.click());
    expect(h.openPicker.mock.calls).toEqual([PICKER_CALL]);
  });

  it('puts a hat on the article, not its cover, for a viewer whose hats are elsewhere', () => {
    h.banners = [BIRTHDAY];
    // Hat 2 is on the cover image, which shares the article's number: still not on the article.
    h.hats = [hat(1), hat(2, { entityType: 'Image', entityId: ARTICLE_ID })];
    const el = card();
    expect(el.querySelector('[data-testid="worn-hat"]')).toBeNull();
    expect(button(el, 'Join a team')).toBeUndefined();
    act(() => button(el, 'Put on a Party Hat')!.click());
    expect(h.openPicker.mock.calls).toEqual([PICKER_CALL]);
  });

  it('shows the hat on this article, swaps it in the picker and takes it off', async () => {
    h.banners = [BIRTHDAY];
    h.hats = [hat(1), hat(3, { entityType: 'Article', entityId: ARTICLE_ID })];
    const el = card();
    expect(text(el.querySelector('[data-testid="worn-hat"]')!)).toBe(
      'Hat 3On this article · 1,240 pts'
    );
    expect(button(el, 'Put on a Party Hat')).toBeUndefined();

    act(() => button(el, 'Swap hat')!.click());
    expect(h.openPicker.mock.calls).toEqual([PICKER_CALL]);

    await act(async () => button(el, 'Take off')!.click());
    expect(h.unequip.mock.calls).toEqual([
      [{ equippedToType: 'Article', equippedToId: ARTICLE_ID, cosmeticId: 3 }],
    ]);
    expect(h.invalidateHats.mock.calls).toEqual([[{ event: 'birthday2026' }]]);
  });

  it('keeps the hat on this article and the error with the hook when taking it off fails', async () => {
    h.banners = [BIRTHDAY];
    h.hats = [hat(3, { entityType: 'Article', entityId: ARTICLE_ID })];
    h.unequip.mockRejectedValueOnce(new Error('nope'));
    const el = card();
    await act(async () => button(el, 'Take off')!.click());
    expect(h.unequip).toHaveBeenCalledTimes(1);
    expect(h.invalidateHats).not.toHaveBeenCalled();
    expect(el.querySelector('[data-testid="worn-hat"]')).not.toBeNull();
  });

  it('lets a hat come off an article whose cover was removed, with nothing to swap to', () => {
    h.banners = [BIRTHDAY];
    h.hats = [hat(3, { entityType: 'Article', entityId: ARTICLE_ID })];
    const el = card({ coverImage: undefined });
    expect(el.querySelector('[data-testid="worn-hat"]')).not.toBeNull();
    expect(button(el, 'Take off')).toBeDefined();
    expect(button(el, 'Swap hat')).toBeUndefined();
  });

  it('asks for no hats and offers nothing for an event whose hats cannot go on articles', () => {
    h.banners = [
      {
        ...BIRTHDAY,
        id: 'event:no-article-hats',
        promo: { ...BIRTHDAY.promo!, event: 'no-article-hats' },
      },
    ];
    h.hats = [hat(1)];
    const el = card();
    expect(text(el)).toContain('Put a party hat on this article.');
    expect(h.hatsInput).toEqual([]);
    expect(el.querySelectorAll('button:not([aria-label^="Hide"])').length).toBe(0);
  });

  it('shows the draft note only while unpublished', () => {
    h.banners = [BIRTHDAY];
    expect(text(card({ showDraftNote: true }))).toContain('Scores once it is published.');
    act(() => root?.unmount());
    expect(text(card({ showDraftNote: false }))).not.toContain('Scores once it is published.');
  });

  it('asks for a cover image instead of a hat button when the article has none', () => {
    h.banners = [BIRTHDAY];
    h.hats = [hat(1)];
    const el = card({ coverImage: undefined });
    expect(text(el)).toContain('Add a cover image to put on a hat.');
    expect(el.querySelectorAll('button:not([aria-label^="Hide"])').length).toBe(0);
  });

  // Must stay the last case: the dismissed-strip store it writes is module scope.
  it('hides only the article editor card when closed, not the post editor one', () => {
    h.banners = [BIRTHDAY];
    const el = card();
    act(() => el.querySelector<HTMLButtonElement>('button[aria-label^="Hide"]')!.click());
    expect(el.querySelector('[data-testid="article-edit-event-card"]')).toBeNull();

    const post = render(
      React.createElement(PostEditEventCard, { coverImage: COVER, showDraftNote: false })
    );
    expect(post.querySelector('[data-testid="post-edit-event-card"]')).not.toBeNull();
  });
});
