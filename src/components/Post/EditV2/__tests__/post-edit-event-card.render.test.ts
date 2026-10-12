// @vitest-environment happy-dom
import { MantineProvider, Menu } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BIRTHDAY_2026_PREVIEW_FROM } from '~/shared/constants/birthday2026.constants';
import type { NavBanner } from '~/shared/constants/nav-banner.constants';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// `banners` and `access` stand in for the gated server answers this viewer gets.
const h = vi.hoisted(() => ({
  banners: [] as NavBanner[],
  access: 'closed' as string,
  openPicker: vi.fn(),
  hats: [] as {
    cosmeticId: number;
    name?: string;
    points?: number;
    data?: { url: string };
    placedOn: { entityType: string; entityId: number } | null;
  }[],
  hatsAsked: [] as unknown[],
  unequip: vi.fn(async () => ({ count: 1 })),
  invalidateHats: vi.fn(async () => undefined),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy(
    {
      'event.getNavBanners': { useQuery: () => ({ data: h.banners }) },
      'event.getAccess': {
        useQuery: (_input: unknown, opts?: { enabled?: unknown }) => ({
          data: opts?.enabled ? h.access : undefined,
        }),
      },
      'event.getMyHats': {
        useQuery: (input: unknown, opts?: { enabled?: boolean }) => {
          if (opts?.enabled === false) return { data: undefined, isLoading: false };
          h.hatsAsked.push(input);
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

const { PostEditEventCard } = await import('~/components/Post/EditV2/PostEditEventCard');
const { AddEventDecorationMenuItem } = await import(
  '~/components/Decorations/AddEventDecorationMenuItem'
);

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
    postEditor: {
      title: 'Civitai turns 4.',
      body: 'Put a party hat on an image in this post.',
      draftNote: 'Scores as people see it, so publish to start earning.',
    },
    modelEditor: { title: 'Civitai turns 4.', body: 'Put a party hat on this model.' },
  },
};
const MODEL_ID = 99;
const COVER = {
  id: 42,
  url: 'img-42',
  width: 512,
  height: 512,
  name: null,
  type: 'image',
} as unknown as React.ComponentProps<typeof PostEditEventCard>['coverImage'] & { id: number };

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});
beforeEach(() => {
  h.banners = [];
  h.access = 'closed';
  h.hats = [];
  h.hatsAsked = [];
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

const card = (props: Partial<React.ComponentProps<typeof PostEditEventCard>> = {}) =>
  render(
    React.createElement(PostEditEventCard, { coverImage: COVER, showDraftNote: true, ...props })
  );
const text = (el: HTMLElement) => el.textContent ?? '';
const button = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll('button')].find((b) => text(b) === label);

describe('post editor event card', () => {
  it('is absent when the gated answer has no promo for this viewer', () => {
    expect(card().querySelector('[data-testid="post-edit-event-card"]')).toBeNull();
  });

  it('shows the event, a hat button for the cover, the draft note and the standings link', () => {
    h.banners = [BIRTHDAY];
    const el = card();
    expect(text(el)).toContain('Civitai turns 4.');
    expect(text(el)).toContain('Put a party hat on an image in this post.');
    expect(text(el)).toContain('Scores as people see it, so publish to start earning.');
    expect(el.querySelector('a')?.getAttribute('href')).toBe('/events/birthday2026/team');

    const button = [...el.querySelectorAll('button')].find((b) =>
      text(b).includes('Put on a Party Hat')
    );
    act(() => button!.click());
    expect(h.openPicker.mock.calls).toEqual([
      [{ props: { entityType: 'Image', entityId: 42, image: COVER, event: 'birthday2026' } }],
    ]);
  });

  it('drops the draft note once published, and the hat button without an image', () => {
    h.banners = [BIRTHDAY];
    const el = card({ showDraftNote: false, coverImage: undefined });
    expect(text(el)).toContain('Civitai turns 4.');
    expect(text(el)).not.toContain('publish to start earning');
    expect(text(el)).not.toContain('Put on a Party Hat');
  });

  it("hats the model for a model's post, with the cover a step aside", () => {
    h.banners = [BIRTHDAY];
    h.hats = [{ cosmeticId: 1, placedOn: null }];
    const el = card({ modelId: MODEL_ID });
    expect(el.querySelector('[data-testid="post-edit-event-card"]')).toBeNull();
    expect(text(el)).toContain('Put a party hat on this model.');
    expect(h.hatsAsked.length).toBeGreaterThan(0);
    expect(h.hatsAsked.filter((i) => JSON.stringify(i) !== '{"event":"birthday2026"}')).toEqual([]);

    act(() => button(el, 'Put on a Party Hat')!.click());
    act(() => button(el, 'or hat the cover image instead')!.click());
    expect(h.openPicker.mock.calls).toEqual([
      [{ props: { entityType: 'Model', entityId: MODEL_ID, image: COVER, event: 'birthday2026' } }],
      [{ props: { entityType: 'Image', entityId: 42, image: COVER, event: 'birthday2026' } }],
    ]);
  });

  it('shows the hat on the model and takes it off the model', async () => {
    h.banners = [BIRTHDAY];
    h.hats = [
      {
        cosmeticId: 3,
        name: 'Party Cap',
        points: 12,
        data: { url: 'hat-3' },
        placedOn: { entityType: 'Model', entityId: MODEL_ID },
      },
    ];
    const el = card({ modelId: MODEL_ID });
    expect(text(el)).toContain('Party CapOn this model · 12 pts');
    await act(async () => button(el, 'Take off')!.click());
    expect(h.unequip.mock.calls).toEqual([
      [{ equippedToType: 'Model', equippedToId: MODEL_ID, cosmeticId: 3 }],
    ]);
  });

  it('keeps the post card for an event with no model copy, and for a post without a model', () => {
    h.banners = [{ ...BIRTHDAY, promo: { ...BIRTHDAY.promo!, modelEditor: undefined } }];
    expect(
      card({ modelId: MODEL_ID }).querySelector('[data-testid="post-edit-event-card"]')
    ).not.toBeNull();
    act(() => root?.unmount());
    host?.remove();
    h.banners = [BIRTHDAY];
    const el = card();
    expect(el.querySelector('[data-testid="post-edit-event-card"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="model-post-edit-event-card"]')).toBeNull();
  });

  // Must stay the last card case: the dismissed-strip store it writes is module scope.
  it('hides for this event when closed', () => {
    h.banners = [BIRTHDAY];
    const el = card();
    act(() => el.querySelector<HTMLButtonElement>('button[aria-label^="Hide"]')!.click());
    expect(el.querySelector('[data-testid="post-edit-event-card"]')).toBeNull();
  });
});

describe('image menu Add Party Hat', () => {
  const item = () =>
    render(
      React.createElement(
        Menu,
        { opened: true, withinPortal: false },
        React.createElement(Menu.Target, null, React.createElement('button', null, 'menu')),
        React.createElement(
          Menu.Dropdown,
          null,
          React.createElement(AddEventDecorationMenuItem, {
            entityType: 'Image',
            entityId: 42,
            image: COVER,
          })
        )
      )
    );

  it('is absent for a viewer the server keeps out of the event', () => {
    expect(text(item())).not.toContain('Party Hat');
  });

  it('opens the picker on this image for a viewer who can wear hats', () => {
    h.access = 'preview';
    const el = item();
    const entry = [...el.querySelectorAll('button')].find((b) => text(b) === 'Add Party Hat');
    act(() => entry!.click());
    expect(h.openPicker.mock.calls).toEqual([
      [{ props: { entityType: 'Image', entityId: 42, image: COVER, event: 'birthday2026' } }],
    ]);
  });
});

describe('menu item reading the worn hat from the viewer', () => {
  const item = (props: { findWornHat?: boolean; currentCosmetic?: { id: number } }) =>
    render(
      React.createElement(
        Menu,
        { opened: true, withinPortal: false },
        React.createElement(Menu.Target, null, React.createElement('button', null, 'menu')),
        React.createElement(
          Menu.Dropdown,
          null,
          React.createElement(AddEventDecorationMenuItem, {
            entityType: 'Model',
            entityId: MODEL_ID,
            image: COVER,
            ...props,
          })
        )
      )
    );

  it('offers to take off the hat the viewer has on this model, and refreshes their hats', async () => {
    h.access = 'preview';
    // Decoys: an image with the model's number, and another model.
    h.hats = [
      { cosmeticId: 2, placedOn: { entityType: 'Image', entityId: MODEL_ID } },
      { cosmeticId: 4, placedOn: { entityType: 'Model', entityId: MODEL_ID + 1 } },
      { cosmeticId: 3, placedOn: { entityType: 'Model', entityId: MODEL_ID } },
    ];
    const el = item({ findWornHat: true });
    await act(async () => button(el, 'Remove Party Hat')!.click());
    expect(h.unequip.mock.calls).toEqual([
      [{ equippedToId: MODEL_ID, equippedToType: 'Model', cosmeticId: 3 }],
    ]);
    expect(h.invalidateHats.mock.calls).toEqual([[{ event: 'birthday2026' }]]);
    expect(h.openPicker).not.toHaveBeenCalled();
  });

  it('leaves their hats as they were when taking it off fails', async () => {
    h.access = 'preview';
    h.hats = [{ cosmeticId: 3, placedOn: { entityType: 'Model', entityId: MODEL_ID } }];
    h.unequip.mockRejectedValueOnce(new Error('nope'));
    const el = item({ findWornHat: true });
    await act(async () => button(el, 'Remove Party Hat')!.click());
    expect(h.unequip).toHaveBeenCalledTimes(1);
    expect(h.invalidateHats).not.toHaveBeenCalled();
  });

  it('offers to add one when none of their hats is on it', () => {
    h.access = 'preview';
    h.hats = [{ cosmeticId: 2, placedOn: { entityType: 'Image', entityId: MODEL_ID } }];
    expect(text(item({ findWornHat: true }))).toContain('Add Party Hat');
  });

  it('takes off the hat the content carries without refreshing hats it never read', async () => {
    h.access = 'preview';
    const el = item({ currentCosmetic: { id: 3 } });
    await act(async () => button(el, 'Remove Party Hat')!.click());
    expect(h.unequip.mock.calls).toEqual([
      [{ equippedToId: MODEL_ID, equippedToType: 'Model', cosmeticId: 3 }],
    ]);
    expect(h.invalidateHats).not.toHaveBeenCalled();
  });

  it("does not ask for the viewer's hats where the content carries its own", () => {
    h.access = 'preview';
    h.hats = [{ cosmeticId: 3, placedOn: { entityType: 'Model', entityId: MODEL_ID } }];
    expect(text(item({}))).toContain('Add Party Hat');
    expect(h.hatsAsked).toEqual([]);
  });
});
