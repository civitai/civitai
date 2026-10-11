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
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'event.getNavBanners': { useQuery: () => ({ data: h.banners }) },
    'event.getAccess': {
      useQuery: (_input: unknown, opts?: { enabled?: unknown }) => ({
        data: opts?.enabled ? h.access : undefined,
      }),
    },
  }),
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
  },
};
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
  h.openPicker.mockClear();
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
  render(React.createElement(PostEditEventCard, { coverImage: COVER, published: false, ...props }));
const text = (el: HTMLElement) => el.textContent ?? '';

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
    const el = card({ published: true, coverImage: undefined });
    expect(text(el)).toContain('Civitai turns 4.');
    expect(text(el)).not.toContain('publish to start earning');
    expect(text(el)).not.toContain('Put on a Party Hat');
  });

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
