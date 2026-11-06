/**
 * The /collections sidebar card holds its list: the list never renders below the card's border,
 * and the last row is reachable by scrolling inside the card.
 *
 * `geometry` tier because the card's `max-height`, the `.sidebar` flex rules and Mantine's
 * ScrollArea only combine under the real cascade. `MyCollections` is replaced by fixed-height
 * stand-ins for its slots (header, filters, invites, rows); the tRPC-backed content is not under
 * test, the box arithmetic is.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';
import { box, cascadeEvidence, nextLayout, renderAtViewport } from '../../../test/geometry-setup';
import { CollectionsLayout } from '~/components/Collections/CollectionsLayout';

const ROW_HEIGHT = 48;
const INVITE_HEIGHT = 64;

const fixture = vi.hoisted(() => ({ rows: 30, invites: 0 }));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, username: 'author', isModerator: false }),
}));
vi.mock('~/hooks/useSubnavBottom', () => ({ SUBNAV_STICKY_GAP: 16, useSubnavBottom: () => 0 }));
vi.mock('~/components/ContainerProvider/useContainerSmallerThan', () => ({
  useContainerSmallerThan: () => false,
}));
vi.mock('~/components/Collections/CollectionCollaborators/CollectionInvitesButton', () => ({
  CollectionInvitesButton: () => null,
}));
vi.mock('~/components/Collections/MyCollections', () => ({
  MyCollections: ({
    children,
  }: {
    children: (slots: Record<string, unknown>) => React.ReactNode;
  }) =>
    children({
      FilterBox: <div style={{ height: 36 }}>filter</div>,
      ListMenu: <div style={{ height: 36, width: 36 }}>menu</div>,
      Filters: <div style={{ height: 40 }}>chips</div>,
      InviteList: fixture.invites ? (
        <div data-testid="invites">
          {Array.from({ length: fixture.invites }, (_, i) => (
            <div key={i} style={{ height: INVITE_HEIGHT }}>
              invite {i}
            </div>
          ))}
        </div>
      ) : null,
      Collections: (
        <div data-testid="rows">
          {Array.from({ length: fixture.rows }, (_, i) => (
            <div key={i} data-testid={`row-${i}`} style={{ height: ROW_HEIGHT }}>
              collection {i}
            </div>
          ))}
        </div>
      ),
      isLoading: false,
    }),
}));

const VIEWPORTS = [
  // 1366x768 and 1920x1080 screens, less roughly 120px of browser chrome
  { width: 1366, height: 650 },
  { width: 1920, height: 960 },
] as const;

const card = () => document.querySelector<HTMLElement>('[class*="sidebar"]:not(button)')!;
const scrollViewport = () =>
  card().querySelector<HTMLElement>('.mantine-ScrollArea-viewport') as HTMLElement;
const scrollRoot = () => card().querySelector<HTMLElement>('.mantine-ScrollArea-root')!;
const toggle = () => card().querySelector<HTMLElement>('[class*="sidebarToggle"]')!;

async function mount(viewport: (typeof VIEWPORTS)[number]) {
  document.documentElement.style.setProperty('--header-height', '60px');
  document.documentElement.style.setProperty('--footer-height', '0px');
  const { observed } = await renderAtViewport(
    <CollectionsLayout>{null}</CollectionsLayout>,
    viewport
  );
  expect(observed).toEqual(viewport);
  expect(cascadeEvidence().probeBoxSizing).toBe('border-box');
  expect(card()).toBeTruthy();
  expect(scrollViewport()).toBeTruthy();
  return card();
}

afterEach(() => {
  cleanup();
  fixture.rows = 30;
  fixture.invites = 0;
});

describe.each(VIEWPORTS)('collections sidebar at $width x $height', (viewport) => {
  test('30 collections: the list stays inside the card and its last row scrolls into view', async () => {
    await mount(viewport);
    const c = box(card());
    const list = box(scrollRoot());
    expect(list.bottom).toBeLessThanOrEqual(c.bottom);
    expect(scrollViewport().scrollHeight).toBeGreaterThan(scrollViewport().clientHeight);

    scrollViewport().scrollTop = scrollViewport().scrollHeight;
    await nextLayout();
    const last = box(document.querySelector('[data-testid="row-29"]')!);
    expect(last.bottom).toBeLessThanOrEqual(box(card()).bottom);
    expect(last.top).toBeGreaterThanOrEqual(box(scrollRoot()).top);
  });

  test('pending invites share the same budget', async () => {
    fixture.invites = 3;
    await mount(viewport);
    expect(box(scrollRoot()).bottom).toBeLessThanOrEqual(box(card()).bottom);
    scrollViewport().scrollTop = scrollViewport().scrollHeight;
    await nextLayout();
    expect(box(document.querySelector('[data-testid="row-29"]')!).bottom).toBeLessThanOrEqual(
      box(card()).bottom
    );
  });

  test('2 collections: the card hugs its content', async () => {
    fixture.rows = 2;
    await mount(viewport);
    const c = box(card());
    const list = box(scrollRoot());
    expect(list.height).toBeGreaterThanOrEqual(2 * ROW_HEIGHT);
    expect(list.bottom).toBeLessThanOrEqual(c.bottom);
    const last = box(document.querySelector('[data-testid="row-1"]')!);
    // no empty stretch: at most the ScrollArea's bottom padding below the last row
    expect(c.bottom - last.bottom).toBeLessThanOrEqual(24);
  });

  test('the gutter toggle stays visible and still collapses and expands the card', async () => {
    await mount(viewport);
    const t = toggle();
    expect(box(t).right).toBeGreaterThan(box(card()).right);
    expect(document.elementFromPoint(box(t).left + 4, box(t).top + 4)?.closest('button')).toBe(t);

    t.click();
    await new Promise((r) => setTimeout(r, 700));
    // the card slides left but keeps its 300px width; only the container's padding is left of it
    expect(box(card()).right).toBeLessThan(20);
    expect(box(toggle()).left).toBeGreaterThanOrEqual(0);

    toggle().click();
    await new Promise((r) => setTimeout(r, 700));
    expect(box(card()).left).toBeGreaterThanOrEqual(0);
    expect(box(card()).width).toBe(300);
  });
});
