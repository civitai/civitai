import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as StickerUtil from '~/components/Sticker/sticker.util';
import type * as TrpcModule from '~/utils/trpc';
import type { PlacedSticker } from '~/components/Sticker/placement.util';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * 🔴 AN OWNER WITH MANY PENDING STICKERS MUST BE ABLE TO TELL WHICH BUTTONS GO
 * WITH WHICH STICKER. A pair per sticker piles up on a cluster, so from two
 * pending on, the owner selects a sticker and answers it from one bar.
 */

const OWNER_ID = 7;

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==';

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: (await import('../../../test/trpcProxyStub')).makeTrpcProxy(),
}));
vi.mock('~/components/Sticker/StickerPlacementActions', () => ({
  StickerPlacementActions: ({ placementIds }: { placementIds: number[] }) => (
    <div>
      <button>Approve</button>
      <button>Decline</button>
      <span data-testid="acting-on">{placementIds.join(',')}</span>
    </div>
  ),
}));
vi.mock('~/components/Sticker/sticker.util', async (importOriginal) => ({
  ...(await importOriginal<typeof StickerUtil>()),
  useStickerCosmetics: () => ({ sticker: new Map() }),
}));
vi.mock('~/components/EdgeMedia/EdgeImage', () => ({
  EdgeImage: ({ src, alt, style }: { src: string; alt: string; style?: object }) => (
    // eslint-disable-next-line @next/next/no-img-element -- a fixture, not app markup.
    <img src={src} alt={alt} style={style} />
  ),
}));
vi.mock('~/components/Sticker/StickerPlacementHoverCard', () => ({
  StickerPlacementHoverCard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { StickerPlacementOverlay } = await import('~/components/Sticker/StickerPlacementOverlay');

const sticker = new Map([[9, { id: 9, name: 'Test', slug: 'test', url: PNG }]]);

const placed = (id: number, x: number, y: number): PlacedSticker =>
  ({
    id,
    imageId: 74,
    placerId: 3,
    ownerId: OWNER_ID,
    status: 'Pending',
    amount: 0,
    free: true,
    hasComment: false,
    isPending: true,
    placedAt: new Date(0),
    data: { cosmeticId: 9, x, y, scale: 0.15, rotation: 0, flip: false, opacity: 1 },
  } as PlacedSticker);

const cluster = Array.from({ length: 8 }, (_, i) =>
  placed(i + 1, 0.4 + (i % 4) * 0.04, 0.4 + Math.floor(i / 4) * 0.05)
);

/** The harness loads no Tailwind; these are the utilities layout relies on. */
const LAYOUT = `
  .absolute{position:absolute} .inset-0{inset:0} .inset-x-0{left:0;right:0}
  .inset-x-2{left:8px;right:8px} .bottom-2{bottom:8px} .bottom-16{bottom:64px} .top-1{top:4px} .bottom-1{bottom:4px}
  .flex{display:flex} .flex-col{flex-direction:column} .flex-wrap{flex-wrap:wrap}
  .items-center{align-items:center} .justify-between{justify-content:space-between}
  .pointer-events-none{pointer-events:none} .pointer-events-auto{pointer-events:auto}
  .overflow-hidden{overflow:hidden} .isolate{isolation:isolate}
  .gap-2{gap:8px} .right-2{right:8px} .top-2{top:8px} .left-2{left:8px}
`;

const stage = (placements: PlacedSticker[], isVideo = false) => (
  <div style={{ position: 'relative', width: 390, height: 390 }}>
    <style>{LAYOUT}</style>
    {isVideo && (
      <div
        data-testid="video-controls"
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 56 }}
      />
    )}
    <StickerPlacementOverlay
      placements={placements}
      viewerId={OWNER_ID}
      sticker={sticker}
      isVideo={isVideo}
    />
  </div>
);

const approveButtons = () => page.getByRole('button', { name: 'Approve' }).elements();
const stickerButtons = () => page.getByRole('button', { name: /^Select / });
// Stickers overlap by design, so a centre-point mouse click lands on whichever is
// on top; selecting is the element's own click.
const select = async (index: number) => {
  await expect.element(stickerButtons().nth(index)).toBeInTheDocument();
  (stickerButtons().nth(index).element() as HTMLElement).click();
};
const visibility = async (name: string) =>
  getComputedStyle((await page.getByText(name).element()) as HTMLElement).visibility;

describe('many pending stickers on one image', () => {
  test('draw no button pair per sticker; selecting one brings up a single pair for it', async () => {
    renderWithProviders(stage(cluster), { user: { id: 7 } });

    await expect.element(page.getByText('Pick a sticker to approve or decline')).toBeVisible();
    await expect.poll(() => approveButtons().length).toBe(0);
    expect(stickerButtons().elements()).toHaveLength(8);

    await select(2);

    await expect.poll(() => approveButtons().length).toBe(1);
    await expect.element(page.getByTestId('acting-on')).toHaveTextContent('3');
    await expect.element(stickerButtons().nth(2)).toHaveAttribute('aria-pressed', 'true');

    await select(5);
    await expect.poll(() => approveButtons().length).toBe(1);
    await expect.element(page.getByTestId('acting-on')).toHaveTextContent('6');

    await select(5);
    await expect.poll(() => approveButtons().length).toBe(0);
    await expect.element(page.getByText('Pick a sticker to approve or decline')).toBeVisible();
  });

  test('Escape from the bar clears the selection', async () => {
    renderWithProviders(stage(cluster), { user: { id: 7 } });
    await select(0);
    await expect.element(page.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    (page.getByRole('button', { name: 'Approve' }).element() as HTMLElement).focus();

    await userEvent.keyboard('{Escape}');

    await expect.poll(() => approveButtons().length).toBe(0);
  });

  test('Escape with focus outside the bar leaves the selection alone', async () => {
    renderWithProviders(stage(cluster), { user: { id: 7 } });
    await select(0);
    await expect.element(page.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    (stickerButtons().nth(1).element() as HTMLElement).focus();

    await userEvent.keyboard('{Escape}');

    await expect.poll(() => approveButtons().length).toBe(1);
  });

  test('exactly two pending already use the bar; a non-owner sees none', async () => {
    const view = await renderWithProviders(stage(cluster.slice(0, 2)), { user: { id: 7 } });
    await expect.element(page.getByText('Pick a sticker to approve or decline')).toBeVisible();
    await expect.poll(() => approveButtons().length).toBe(0);

    await view.rerender(
      <div style={{ position: 'relative', width: 390, height: 390 }}>
        <style>{LAYOUT}</style>
        <StickerPlacementOverlay placements={cluster} viewerId={99} sticker={sticker} />
      </div>
    );
    await expect
      .element(page.getByRole('group', { name: 'Pending stickers' }))
      .not.toBeInTheDocument();
  });

  test('links to the received sticker queue', async () => {
    renderWithProviders(stage(cluster), { user: { id: 7 } });
    await expect
      .element(page.getByRole('link', { name: 'Review all' }))
      .toHaveAttribute('href', '/user/placements?type=sticker&tab=received');
  });

  test('Hide controls hides the bar and its buttons', async () => {
    renderWithProviders(stage(cluster), { user: { id: 7 } });
    await select(0);
    expect(await visibility('Approve')).toBe('visible');

    await userEvent.click(page.getByRole('button', { name: 'Hide controls' }));

    expect(await visibility('Approve')).toBe('hidden');
    expect(await visibility('Review all')).toBe('hidden');
  });

  test('at phone width the bar and its buttons stay inside the image', async () => {
    await page.viewport(390, 800);
    renderWithProviders(stage(cluster), { user: { id: 7 } });
    await select(0);

    const box = (el: Element) => el.getBoundingClientRect();
    const approve = box(page.getByRole('button', { name: 'Approve' }).element());
    const decline = box(page.getByRole('button', { name: 'Decline' }).element());
    const bar = box(page.getByRole('group', { name: 'Pending stickers' }).element());
    for (const rect of [approve, decline, bar]) {
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(390);
      expect(rect.bottom).toBeLessThanOrEqual(800);
    }
    expect(approve.right).toBeLessThanOrEqual(decline.left + 1);
  });
});

describe('the bar keeps clear of stickers and the Hide controls pill', () => {
  const overlaps = (a: DOMRect, b: DOMRect) =>
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const rectOf = (el: Element) => el.getBoundingClientRect();

  test.each([
    ['clustered mid-image', cluster],
    ['one at the bottom edge', [...cluster.slice(0, 7), placed(8, 0.5, 0.95)]],
    ['one at the top edge', [...cluster.slice(0, 7), placed(8, 0.5, 0.05)]],
  ])('%s', async (_name, placements) => {
    renderWithProviders(stage(placements), { user: { id: 7 } });
    await select(0);

    const bar = rectOf(page.getByRole('group', { name: 'Pending stickers' }).element());
    const pill = rectOf(page.getByRole('button', { name: 'Hide controls' }).element());
    expect(overlaps(bar, pill)).toBe(false);
    // The bar must not cover any rendered sticker; an edge sticker is what forces it to the other side.
    for (const el of stickerButtons().elements()) {
      const box = rectOf(el);
      if (box.height > 0) expect(overlaps(bar, box)).toBe(false);
    }
  });

  test.each([
    ['clustered mid-image', cluster],
    ['one at the top edge', [...cluster.slice(0, 7), placed(8, 0.5, 0.05)]],
  ])('on a video, %s, the bar stays off the controls', async (_name, placements) => {
    renderWithProviders(stage(placements, true), { user: { id: 7 } });
    await select(0);

    const bar = rectOf(page.getByRole('group', { name: 'Pending stickers' }).element());
    const controls = rectOf(page.getByTestId('video-controls').element());
    expect(controls.height).toBeGreaterThan(0);
    expect(overlaps(bar, controls)).toBe(false);
  });

  test('a sticker at the bottom edge is still selectable', async () => {
    renderWithProviders(stage([...cluster.slice(0, 7), placed(8, 0.5, 0.95)]), {
      user: { id: 7 },
    });
    await select(7);
    await expect.element(stickerButtons().nth(7)).toHaveAttribute('aria-pressed', 'true');
    await expect.element(page.getByTestId('acting-on')).toHaveTextContent('8');
  });
});

describe('one pending sticker', () => {
  test('keeps its own pair and needs no selection', async () => {
    renderWithProviders(stage([cluster[0]]), { user: { id: 7 } });

    await expect.element(page.getByRole('button', { name: 'Approve' })).toBeVisible();
    await expect.poll(() => approveButtons().length).toBe(1);
    expect(stickerButtons().elements()).toHaveLength(0);
    await expect
      .element(page.getByText('Pick a sticker to approve or decline'))
      .not.toBeInTheDocument();
  });
});
