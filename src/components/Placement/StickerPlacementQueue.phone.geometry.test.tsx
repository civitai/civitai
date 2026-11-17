import { describe, expect, test, vi } from 'vitest';
import { Container } from '@mantine/core';
import { page, userEvent } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import type * as BrowsingLevelMod from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as StickerUtil from '~/components/Sticker/sticker.util';
import { box, renderAtViewport } from '../../../test/geometry-setup';

/**
 * A pending placement row on a phone: Approve, Decline and the sentence about money
 * above them must all be on screen. The row used to be one nowrap line, which pushed
 * the buttons off the right edge.
 */

const LONG_USERNAME = 'a_very_long_placer_username_34ch';
const NOTE = 'Love this one, please put it next to the logo and keep the colours. '.repeat(3);

const mocks = vi.hoisted(() => {
  const PIXEL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==';
  const state = { comment: null as string | null, username: 'x' };
  const row = () => ({
    id: 1,
    targetId: 10,
    free: false,
    amount: 25,
    createdAt: new Date('2026-11-01T00:00:00Z'),
    expiresAt: new Date('2026-11-03T00:00:00Z'),
    placer: { username: state.username },
    data: { cosmeticId: 5, comment: state.comment },
    image: { id: 10, url: 'x', type: 'image', name: 'n', viewable: true, nsfwLevel: 1 },
  });
  return { PIXEL, state, row };
});

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: (await import('../../../test/trpcProxyStub')).makeTrpcProxy({
    'placement.getPending': {
      useInfiniteQuery: () => ({
        data: { pages: [{ items: [mocks.row()], nextCursor: undefined }] },
        isLoading: false,
        isError: false,
        hasNextPage: false,
        isFetchingNextPage: false,
        fetchNextPage: vi.fn(),
      }),
    },
  }),
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelMod>()),
  useBrowsingLevelDebounced: () => 1,
}));
vi.mock('~/components/Sticker/sticker.util', async (importOriginal) => ({
  ...(await importOriginal<typeof StickerUtil>()),
  useStickerCosmetics: () => ({
    sticker: new Map([[5, { url: mocks.PIXEL, slug: 'star', name: 'Orange Pinwheel' }]]),
  }),
}));
vi.mock('~/components/Placement/useWithheldHref', () => ({
  useWithheldHref: () => () => '/withheld',
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  EdgeMedia: ({ style }: { style?: object }) => (
    // eslint-disable-next-line @next/next/no-img-element -- a fixture, not app markup.
    <img src={mocks.PIXEL} alt="" style={style} />
  ),
}));
vi.mock('~/components/EdgeMedia/EdgeImage', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  EdgeImage: ({ style }: { style?: object }) => (
    // eslint-disable-next-line @next/next/no-img-element -- a fixture, not app markup.
    <img src={mocks.PIXEL} alt="" style={style} />
  ),
}));

const { StickerPlacementQueue } = await import('~/components/Placement/StickerPlacementQueue');

const PHONES = [
  { width: 360, height: 740 },
  { width: 412, height: 915 },
] as const;
const DESKTOP = { width: 1280, height: 800 } as const;

async function renderRow(
  viewport: { width: number; height: number },
  opts: { username?: string; comment?: string | null } = {}
) {
  mocks.state.username = opts.username ?? LONG_USERNAME;
  mocks.state.comment = opts.comment ?? null;
  const { observed } = await renderAtViewport(
    // The page's own container: the real row has 16px less each side than the window.
    <Container size="md" my="md">
      <StickerPlacementQueue />
    </Container>,
    viewport
  );
  expect(observed.width).toBe(viewport.width);
  return viewport.width;
}

const approve = () => page.getByRole('button', { name: 'Approve', exact: true });
const decline = () => page.getByRole('button', { name: 'Decline', exact: true });
const moneyLine = () => page.getByText(/paid 25 Buzz/);

function expectInViewport(el: Element, width: number, what: string) {
  const b = box(el);
  expect(b.left, `${what} left edge @${width}`).toBeGreaterThanOrEqual(0);
  expect(b.right, `${what} right edge @${width}`).toBeLessThanOrEqual(width);
}

describe.each(PHONES)('pending sticker row at $width px', (viewport) => {
  test('Approve, Decline and the money line are fully on screen with a 34-char username', async () => {
    const width = await renderRow(viewport);
    const a = approve().element();
    const d = decline().element();

    expectInViewport(a, width, 'Approve');
    expectInViewport(d, width, 'Decline');
    expectInViewport(moneyLine().element(), width, 'money line');
    expect(
      document.documentElement.scrollWidth,
      `page scrolls sideways @${width}`
    ).toBeLessThanOrEqual(width);
    // Same order every width: Approve then Decline.
    expect(box(a).left).toBeLessThan(box(d).left);
    // A thumb-sized target, and the money line sits above the buttons rather than below.
    expect(box(a).height).toBeGreaterThanOrEqual(32);
    expect(box(d).height).toBeGreaterThanOrEqual(32);
    expect(box(moneyLine().element()).bottom).toBeLessThanOrEqual(box(a).top);
  });

  test('a short username fits too', async () => {
    const width = await renderRow(viewport, { username: 'RisingV' });
    expectInViewport(approve().element(), width, 'Approve');
    expectInViewport(decline().element(), width, 'Decline');
  });

  test('a long note adds the note choices, and every choice stays on screen', async () => {
    const width = await renderRow(viewport, { comment: NOTE });
    expectInViewport(approve().element(), width, 'Approve');
    expectInViewport(decline().element(), width, 'Decline');
    expectInViewport(moneyLine().element(), width, 'money line');

    await userEvent.click(approve());
    const without = page.getByRole('button', { name: /Approve without it/ });
    await expect.element(without).toBeVisible();
    expectInViewport(without.element(), width, 'Approve without it');
    expectInViewport(
      page.getByRole('button', { name: /Approve with the note/ }).element(),
      width,
      'Approve with the note'
    );
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  });
});

test('desktop keeps the buttons in a column to the right of the text', async () => {
  const width = await renderRow(DESKTOP);
  const a = box(approve().element());
  const d = box(decline().element());
  expectInViewport(approve().element(), width, 'Approve');
  expect(a.left).toBeGreaterThanOrEqual(box(moneyLine().element()).right);
  // Stacked: same column, Decline under Approve.
  expect(d.top).toBeGreaterThan(a.bottom - 1);
  expect(Math.abs(d.left - a.left)).toBeLessThan(2);
});
