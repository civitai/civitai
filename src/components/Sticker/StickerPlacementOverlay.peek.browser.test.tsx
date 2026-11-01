import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as StickerUtil from '~/components/Sticker/sticker.util';
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

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 7 }) }));
vi.mock('~/components/Sticker/StickerPlacementActions', () => ({
  StickerPlacementActions: () => (
    <div>
      <button>Approve</button>
      <button>Decline</button>
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

const sticker = new Map([[9, { id: 9, name: 'Test', slug: 'test', url: PNG }]]);

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
`;

const stage = (placements: PlacedSticker[], viewerId = OWNER_ID) => (
  <div style={{ position: 'relative', width: 390, height: 390 }}>
    <style>{LAYOUT}</style>
    <StickerPlacementOverlay placements={placements} viewerId={viewerId} sticker={sticker} />
  </div>
);

const renderOverlay = (placements: PlacedSticker[], viewerId = OWNER_ID) =>
  renderWithProviders(stage(placements, viewerId));

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
});
