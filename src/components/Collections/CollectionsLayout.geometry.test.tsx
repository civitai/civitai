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
      Filters: <div style={{ height: 30 }}>chips</div>,
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
  // laptop windows with a bookmarks bar or a split screen
  { width: 1366, height: 500 },
  { width: 1920, height: 700 },
] as const;

const card = () => document.querySelector<HTMLElement>('[class*="sidebar"]:not(button)')!;
const scrollViewport = () =>
  card().querySelector<HTMLElement>('.mantine-ScrollArea-viewport') as HTMLElement;
const scrollRoot = () => card().querySelector<HTMLElement>('.mantine-ScrollArea-root')!;
const toggle = () => card().querySelector<HTMLElement>('[class*="sidebarToggle"]')!;

async function mount(viewport: (typeof VIEWPORTS)[number]) {
  document.documentElement.style.setProperty('--footer-height', '0px');
  const { observed } = await renderAtViewport(
    <CollectionsLayout>{null}</CollectionsLayout>,
    viewport
  );
  expect(observed).toEqual(viewport);
  expect(getComputedStyle(document.documentElement).getPropertyValue('--header-height')).toBe(
    '60px'
  );
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
    expect(last.bottom).toBeLessThanOrEqual(box(scrollRoot()).bottom);
    expect(last.top).toBeGreaterThanOrEqual(box(scrollRoot()).top);
  });

  test('pending invites share the same budget', async () => {
    fixture.invites = 3;
    await mount(viewport);
    const invites = card().querySelector<HTMLElement>('[data-testid="invites"]');
    expect(invites?.children).toHaveLength(3);
    expect(box(invites!).height).toBe(3 * INVITE_HEIGHT);
    expect(box(invites!).bottom).toBeLessThanOrEqual(box(card()).bottom);
    expect(box(scrollRoot()).bottom).toBeLessThanOrEqual(box(card()).bottom);
    scrollViewport().scrollTop = scrollViewport().scrollHeight;
    await nextLayout();
    expect(box(document.querySelector('[data-testid="row-29"]')!).bottom).toBeLessThanOrEqual(
      box(scrollRoot()).bottom
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
    expect(c.bottom - last.bottom).toBeLessThanOrEqual(18);
  });

  test('the gutter toggle stays visible and still collapses and expands the card', async () => {
    await mount(viewport);
    const t = toggle();
    expect(box(t).right).toBeGreaterThan(box(card()).right);
    expect(document.elementFromPoint(box(t).left + 4, box(t).top + 4)?.closest('button')).toBe(t);

    t.click();
    // the card slides left but keeps its 300px width; only the container's padding is left of it
    await expect.poll(() => box(card()).right, { timeout: 3000 }).toBeLessThan(20);
    expect(box(toggle()).left).toBeGreaterThanOrEqual(0);

    toggle().click();
    await expect.poll(() => box(card()).left, { timeout: 3000 }).toBeGreaterThanOrEqual(0);
    expect(box(card()).width).toBe(300);
  });
});
