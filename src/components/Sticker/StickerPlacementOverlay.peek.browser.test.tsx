import { describe, expect, onTestFinished, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as StickerUtil from '~/components/Sticker/sticker.util';
import type * as TrpcModule from '~/utils/trpc';
import type { PlacedSticker } from '~/components/Sticker/placement.util';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * 🔴 THE OWNER MUST BE ABLE TO SEE THE STICKER THEY ARE ASKED TO APPROVE.
 *
 * A pending placement is drawn with a "Free placement" mark inside its box and
 * the owner's Approve/Decline just below it. On a phone those cover most of a
 * small sticker, and nothing could dismiss them. The peek toggle hides the
 * chrome with `visibility`, so a hidden control also takes no tap.
 */

const OWNER_ID = 7;

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==';

// The event hat's popover reads tRPC; this test only needs where the hat is drawn.
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
// The hook runs even when the artwork is handed in, and wants a tRPC context.
vi.mock('~/components/Sticker/sticker.util', async (importOriginal) => ({
  ...(await importOriginal<typeof StickerUtil>()),
  useStickerCosmetics: () => ({ sticker: new Map() }),
}));
// The real one rewrites the URL to the CDN, which a fixture cannot reach, and a
// sticker that fails to load has no height for the marks to fit in.
vi.mock('~/components/EdgeMedia/EdgeImage', () => ({
  EdgeImage: ({ src, alt, style }: { src: string; alt: string; style?: object }) => (
    // eslint-disable-next-line @next/next/no-img-element -- a fixture, not app markup.
    <img src={src} alt={alt} style={style} />
  ),
}));
// A hover card needs queries of its own; what is asserted is the layer around it.
vi.mock('~/components/Sticker/StickerPlacementHoverCard', () => ({
  StickerPlacementHoverCard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { StickerPlacementOverlay } = await import('~/components/Sticker/StickerPlacementOverlay');
const { ImageMediaHat } = await import(
  '~/components/Cosmetics/EventDecoration/EventDecorationOverlay'
);
const { EVENT_HAT_CORNERS } = await import('~/components/Sticker/peek-toggle-corner');

const sticker = new Map([[9, { id: 9, name: 'Test', slug: 'test', url: PNG }]]);

describe('a sticker outside its moment', () => {
  test('is hidden but stays mounted, and only that one', async () => {
    renderWithProviders(
      <div style={{ position: 'relative', width: 400, height: 400 }}>
        <StickerPlacementOverlay
          placements={[
            placed({ id: 1, isPending: false }),
            placed({ id: 2, isPending: false, data: { ...placed().data, cosmeticId: 8 } }),
          ]}
          viewerId={99}
          sticker={
            new Map([...sticker, [8, { id: 8, name: 'Other', slug: 'other', url: PNG }]]) as never
          }
          hiddenIds={new Set([1])}
        />
      </div>,
      { user: { id: 7 } }
    );

    const stickerBox = (alt: string) =>
      (page.getByAltText(alt).element() as HTMLElement).closest<HTMLElement>('.absolute')!;

    await expect.element(page.getByAltText(':test:')).toBeInTheDocument();
    // The class, because the harness has no stylesheet.
    expect(stickerBox(':test:').classList).toContain('!invisible');
    expect(stickerBox(':other:').classList).not.toContain('!invisible');
  });
});

const placed = (overrides: Partial<PlacedSticker> = {}): PlacedSticker =>
  ({
    id: 1,
    imageId: 74,
    placerId: 3,
    ownerId: OWNER_ID,
    status: 'Pending',
    amount: 0,
    free: true,
    hasComment: false,
    isPending: true,
    placedAt: new Date(0),
    data: { cosmeticId: 9, x: 0.5, y: 0.4, scale: 0.3, rotation: 0, flip: false, opacity: 1 },
    ...overrides,
  } as PlacedSticker);

/**
 * The harness loads no Tailwind, and the overlay measures its own box to decide
 * whether a mark fits — an unsized box draws no marks at all. These are the few
 * utilities that sizing and the marks' placement rely on.
 */
const LAYOUT = `
  .absolute{position:absolute} .inset-0{inset:0} .inset-x-0{left:0;right:0}
  .top-1{top:4px} .bottom-1{bottom:4px} .flex{display:flex} .flex-col{flex-direction:column}
  .items-center{align-items:center} .right-2{right:8px} .top-2{top:8px}
  .left-2{left:8px} .bottom-2{bottom:8px}
`;

const stage = (placements: PlacedSticker[], viewerId = OWNER_ID, wearsHat = false) => (
  <div style={{ position: 'relative', width: 390, height: 390 }}>
    <style>{LAYOUT}</style>
    {wearsHat && (
      <ImageMediaHat
        imageId={1}
        decoration={{ data: { type: 'hat', event: 'birthday2026', url: PNG } }}
      />
    )}
    <StickerPlacementOverlay
      placements={placements}
      viewerId={viewerId}
      sticker={sticker}
      takenCorners={wearsHat ? EVENT_HAT_CORNERS : undefined}
    />
  </div>
);

const renderOverlay = (placements: PlacedSticker[], viewerId = OWNER_ID) =>
  renderWithProviders(stage(placements, viewerId), { user: { id: 7 } });

const visibility = async (name: string) =>
  getComputedStyle((await page.getByText(name).element()) as HTMLElement).visibility;

describe('peeking past the review chrome', () => {
  test('the owner can hide the controls and the pill, and bring them back', async () => {
    renderOverlay([placed()]);

    const toggle = page.getByRole('button', { name: 'Hide controls' });
    await expect.element(toggle).toBeInTheDocument();
    expect(await visibility('Free placement')).toBe('visible');
    expect(await visibility('Approve')).toBe('visible');

    await userEvent.click(toggle);

    const shown = page.getByRole('button', { name: 'Show controls' });
    await expect.element(shown).toHaveAttribute('aria-pressed', 'true');
    expect(await visibility('Free placement')).toBe('hidden');
    expect(await visibility('Approve')).toBe('hidden');
    expect(await visibility('Decline')).toBe('hidden');
    // The artwork is what they came to see.
    await expect.element(page.getByAltText(':test:')).toBeInTheDocument();

    await userEvent.click(shown);

    expect(await visibility('Approve')).toBe('visible');
    expect(await visibility('Free placement')).toBe('visible');
  });

  test('answering the last pending placement does not leave the next one hidden', async () => {
    const view = await renderOverlay([placed()]);
    await userEvent.click(page.getByRole('button', { name: 'Hide controls' }));
    await expect.element(page.getByRole('button', { name: 'Show controls' })).toBeInTheDocument();

    // Approved: nothing pending any more.
    await view.rerender(stage([placed({ isPending: false, status: 'Approved' })]));
    await expect
      .element(page.getByRole('button', { name: 'Show controls' }))
      .not.toBeInTheDocument();

    // A new request arrives: it must come up with its controls showing.
    await view.rerender(stage([placed({ id: 2 })]));
    await expect.element(page.getByRole('button', { name: 'Hide controls' })).toBeInTheDocument();
    expect(await visibility('Approve')).toBe('visible');
  });

  test('a viewer with nothing to answer gets no toggle', async () => {
    renderOverlay([placed()], 99);

    await expect.element(page.getByAltText(':test:')).toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: 'Hide controls' }))
      .not.toBeInTheDocument();
  });

  // A tester's report: a sticker placed near the top-right corner sat under the
  // pill, with its Approve/Decline peeking out below it.
  test('the toggle stays off a pending sticker placed in its corner', async () => {
    renderOverlay([
      placed({
        data: { cosmeticId: 9, x: 0.85, y: 0.1, scale: 0.3, rotation: 0, flip: false, opacity: 1 },
      }),
    ]);

    const toggle = page.getByRole('button', { name: 'Hide controls' });
    await expect.element(toggle).toBeInTheDocument();
    const rect = async (el: ReturnType<typeof page.getByText>) =>
      ((await el.element()) as HTMLElement).getBoundingClientRect();
    const overlaps = (a: DOMRect, b: DOMRect) =>
      a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

    const pill = await rect(toggle);
    const art = await rect(page.getByAltText(':test:'));
    expect(art.height).toBeGreaterThan(0);
    expect(overlaps(pill, art)).toBe(false);
    expect(overlaps(pill, await rect(page.getByText('Approve')))).toBe(false);
    expect(overlaps(pill, await rect(page.getByText('Decline')))).toBe(false);
  });

  // A tester's report: with a sticker near the top-right, the toggle moved to the top-left, under
  // the image's event hat.
  test('the toggle stays off the event hat the image wears', async () => {
    renderWithProviders(
      stage(
        [
          placed({
            data: {
              cosmeticId: 9,
              x: 0.85,
              y: 0.1,
              scale: 0.3,
              rotation: 0,
              flip: false,
              opacity: 1,
            },
          }),
        ],
        OWNER_ID,
        true
      ),
      { user: { id: 7 } }
    );

    const toggle = page.getByRole('button', { name: 'Hide controls' });
    await expect.element(toggle).toBeInTheDocument();
    const hat = document.querySelector('[data-event-decoration="hat"]') as HTMLElement | null;
    expect(hat).not.toBeNull();
    const h = hat!.getBoundingClientRect();
    expect(h.width).toBeGreaterThan(0);
    const pill = ((await toggle.element()) as HTMLElement).getBoundingClientRect();
    const overlaps = (a: DOMRect, b: DOMRect) =>
      a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    expect(overlaps(pill, h)).toBe(false);
    expect(
      overlaps(pill, (page.getByAltText(':test:').element() as HTMLElement).getBoundingClientRect())
    ).toBe(false);
  });
});

// Many pending stickers on one image: one bar, not a button pair per sticker.
const pendingAt = (id: number, x: number, y: number): PlacedSticker =>
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
  pendingAt(i + 1, 0.4 + (i % 4) * 0.04, 0.4 + Math.floor(i / 4) * 0.05)
);

/** The harness loads no Tailwind; these are the utilities layout relies on. */
const CROWDED_LAYOUT = `
  .absolute{position:absolute} .inset-0{inset:0} .inset-x-0{left:0;right:0}
  .inset-x-2{left:8px;right:8px} .bottom-2{bottom:8px} .bottom-16{bottom:64px} .right-44{right:176px} .left-44{left:176px} .top-1{top:4px} .bottom-1{bottom:4px}
  .flex{display:flex} .flex-col{flex-direction:column} .flex-wrap{flex-wrap:wrap}
  .items-center{align-items:center} .justify-between{justify-content:space-between}
  .pointer-events-none{pointer-events:none} .pointer-events-auto{pointer-events:auto}
  .overflow-hidden{overflow:hidden} .isolate{isolation:isolate}
  .gap-2{gap:8px} .right-2{right:8px} .top-2{top:8px} .left-2{left:8px}
`;

const crowdedStage = (placements: PlacedSticker[], isVideo = false, step?: number) => (
  <div data-testid="stage" style={{ position: 'relative', width: 390, height: 390 }}>
    <style>{CROWDED_LAYOUT}</style>
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
      step={step}
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

describe('many pending stickers on one image', () => {
  test('draw no button pair per sticker; selecting one brings up a single pair for it', async () => {
    renderWithProviders(crowdedStage(cluster), { user: { id: 7 } });

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

  test('Escape from the bar clears the selection and does not reach the page', async () => {
    const reached = vi.fn();
    document.addEventListener('keydown', reached);
    try {
      renderWithProviders(crowdedStage(cluster), { user: { id: 7 } });
      await select(0);
      await expect.element(page.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
      (page.getByRole('button', { name: 'Approve' }).element() as HTMLElement).focus();

      await userEvent.keyboard('{Escape}');

      await expect.poll(() => approveButtons().length).toBe(0);
      expect(reached).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', reached);
    }
  });

  test('Escape with nothing selected still reaches the page, so a dialog can close', async () => {
    const reached = vi.fn();
    document.addEventListener('keydown', reached);
    try {
      renderWithProviders(crowdedStage(cluster), { user: { id: 7 } });
      await expect.element(page.getByRole('link', { name: 'Review all' })).toBeInTheDocument();
      (page.getByRole('link', { name: 'Review all' }).element() as HTMLElement).focus();

      await userEvent.keyboard('{Escape}');

      expect(reached).toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', reached);
    }
  });

  test('exactly two pending already use the bar; a non-owner sees none', async () => {
    const view = await renderWithProviders(crowdedStage(cluster.slice(0, 2)), { user: { id: 7 } });
    await expect.element(page.getByText('Pick a sticker to approve or decline')).toBeVisible();
    await expect.poll(() => approveButtons().length).toBe(0);

    await view.rerender(
      <div style={{ position: 'relative', width: 390, height: 390 }}>
        <style>{CROWDED_LAYOUT}</style>
        <StickerPlacementOverlay placements={cluster} viewerId={99} sticker={sticker} />
      </div>
    );
    await expect
      .element(page.getByRole('group', { name: 'Pending stickers' }))
      .not.toBeInTheDocument();
  });

  test('counts only the stickers drawn so far, so a history replay is not offered the rest', async () => {
    renderWithProviders(crowdedStage(cluster, false, 0), { user: { id: 7 } });

    await expect.element(page.getByRole('button', { name: 'Approve' })).toBeVisible();
    await expect
      .element(page.getByRole('group', { name: 'Pending stickers' }))
      .not.toBeInTheDocument();
  });

  test('a non-interactive surface (a feed card, a post) never gets the bar', async () => {
    renderWithProviders(
      <div style={{ position: 'relative', width: 390, height: 390 }}>
        <style>{CROWDED_LAYOUT}</style>
        <StickerPlacementOverlay
          placements={cluster}
          viewerId={OWNER_ID}
          sticker={sticker}
          interactive={false}
        />
      </div>,
      { user: { id: 7 } }
    );
    await expect.element(page.getByAltText(':test:').first()).toBeInTheDocument();
    await expect
      .element(page.getByRole('group', { name: 'Pending stickers' }))
      .not.toBeInTheDocument();
  });

  test('links to the received sticker queue', async () => {
    renderWithProviders(crowdedStage(cluster), { user: { id: 7 } });
    await expect
      .element(page.getByRole('link', { name: 'Review all' }))
      .toHaveAttribute('href', '/user/placements?type=sticker&tab=received');
  });

  test('Hide controls hides the bar and its buttons', async () => {
    renderWithProviders(crowdedStage(cluster), { user: { id: 7 } });
    await select(0);
    expect(await visibility('Approve')).toBe('visible');

    await userEvent.click(page.getByRole('button', { name: 'Hide controls' }));

    expect(await visibility('Approve')).toBe('hidden');
    expect(await visibility('Review all')).toBe('hidden');
  });

  // Crowded layout only: the harness loads no Tailwind, so max-sm wrapping is not exercised.
  test('the bar and its buttons stay inside the image box', async () => {
    const { innerWidth, innerHeight } = window;
    await page.viewport(390, 800);
    onTestFinished(() => page.viewport(innerWidth, innerHeight));
    renderWithProviders(crowdedStage(cluster), { user: { id: 7 } });
    await select(0);

    const box = (el: Element) => el.getBoundingClientRect();
    const approve = box(page.getByRole('button', { name: 'Approve' }).element());
    const decline = box(page.getByRole('button', { name: 'Decline' }).element());
    const bar = box(page.getByRole('group', { name: 'Pending stickers' }).element());
    // Bounded by the image box, not the (taller) viewport.
    const image = box(page.getByTestId('stage').element());
    for (const rect of [approve, decline, bar]) {
      expect(rect.left).toBeGreaterThanOrEqual(image.left);
      expect(rect.right).toBeLessThanOrEqual(image.right);
      expect(rect.top).toBeGreaterThanOrEqual(image.top);
      expect(rect.bottom).toBeLessThanOrEqual(image.bottom);
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
    ['one at the bottom edge', [...cluster.slice(0, 7), pendingAt(8, 0.5, 0.95)]],
    ['one at the top edge', [...cluster.slice(0, 7), pendingAt(8, 0.5, 0.05)]],
  ])('%s', async (_name, placements) => {
    renderWithProviders(crowdedStage(placements), { user: { id: 7 } });
    await select(0);

    const bar = rectOf(page.getByRole('group', { name: 'Pending stickers' }).element());
    const pill = rectOf(page.getByRole('button', { name: 'Hide controls' }).element());
    expect(overlaps(bar, pill)).toBe(false);
    // The bar must not cover any rendered sticker; an edge sticker is what forces it to the other side.
    const boxes = stickerButtons()
      .elements()
      .map(rectOf)
      .filter((box) => box.height > 0);
    expect(boxes).toHaveLength(placements.length);
    for (const box of boxes) expect(overlaps(bar, box)).toBe(false);
  });

  test.each([
    ['clustered mid-image', cluster],
    ['one at the top edge', [...cluster.slice(0, 7), pendingAt(8, 0.5, 0.05)]],
  ])('on a video, %s, the bar stays off the controls', async (_name, placements) => {
    renderWithProviders(crowdedStage(placements, true), { user: { id: 7 } });
    await select(0);

    const bar = rectOf(page.getByRole('group', { name: 'Pending stickers' }).element());
    const controls = rectOf(page.getByTestId('video-controls').element());
    expect(controls.height).toBeGreaterThan(0);
    expect(overlaps(bar, controls)).toBe(false);
    const pill = rectOf(page.getByRole('button', { name: 'Hide controls' }).element());
    expect(overlaps(pill, controls)).toBe(false);
    expect(overlaps(pill, bar)).toBe(false);
  });

  test('on a video, the pill falls back to the top-left and the bar leaves that side', async () => {
    // Out of the top strip (so the bar stays on top) but near the top-right corner.
    renderWithProviders(crowdedStage([...cluster.slice(0, 7), pendingAt(8, 0.9, 0.35)], true), {
      user: { id: 7 },
    });
    await select(0);

    const pill = rectOf(page.getByRole('button', { name: 'Hide controls' }).element());
    const bar = rectOf(page.getByRole('group', { name: 'Pending stickers' }).element());
    const stage = rectOf(page.getByTestId('stage').element());
    expect(pill.left - stage.left).toBeLessThan(stage.width / 2);
    expect(overlaps(pill, bar)).toBe(false);
  });

  test('Enter and Space select a pending sticker from the keyboard', async () => {
    renderWithProviders(crowdedStage(cluster), { user: { id: 7 } });
    await expect.element(stickerButtons().nth(1)).toBeInTheDocument();

    (stickerButtons().nth(1).element() as HTMLElement).focus();
    await userEvent.keyboard('{Enter}');
    await expect.element(stickerButtons().nth(1)).toHaveAttribute('aria-pressed', 'true');
    await expect.element(page.getByTestId('acting-on')).toHaveTextContent('2');

    (stickerButtons().nth(3).element() as HTMLElement).focus();
    await userEvent.keyboard(' ');
    await expect.element(stickerButtons().nth(3)).toHaveAttribute('aria-pressed', 'true');
    await expect.element(page.getByTestId('acting-on')).toHaveTextContent('4');
  });

  test('a sticker at the bottom edge is still selectable', async () => {
    renderWithProviders(crowdedStage([...cluster.slice(0, 7), pendingAt(8, 0.5, 0.95)]), {
      user: { id: 7 },
    });
    await select(7);
    await expect.element(stickerButtons().nth(7)).toHaveAttribute('aria-pressed', 'true');
    await expect.element(page.getByTestId('acting-on')).toHaveTextContent('8');
  });
});

describe('one pending sticker', () => {
  test('keeps its own pair and needs no selection', async () => {
    renderWithProviders(crowdedStage([cluster[0]]), { user: { id: 7 } });

    await expect.element(page.getByRole('button', { name: 'Approve' })).toBeVisible();
    await expect.poll(() => approveButtons().length).toBe(1);
    expect(stickerButtons().elements()).toHaveLength(0);
    await expect
      .element(page.getByText('Pick a sticker to approve or decline'))
      .not.toBeInTheDocument();
  });
});
