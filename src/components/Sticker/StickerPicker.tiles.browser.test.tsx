import '~/styles/globals.css';
import '@mantine/core/styles.layer.css';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * The picker's stickers were 28px — too small to tell apart. Pins the tile size,
 * the large preview (hover on desktop, long press on touch), and that chat —
 * which mounts the same picker — gets the preview without any creator line.
 */
const svg = (color: string) =>
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><circle cx="64" cy="64" r="60" fill="${color}"/></svg>`
  );
const stickers = [
  { id: 1, name: 'Happy Frog', slug: 'happy_frog', url: svg('#12b886'), createdById: 5, flags: 0 },
  { id: 2, name: 'Sad Cat', slug: 'sad_cat', url: svg('#fa5252'), createdById: 5, flags: 0 },
];

const mocks = vi.hoisted(() => ({
  hoverCapable: true,
  attributionIds: [] as Array<number | null>,
}));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useFeatureFlags: () => ({ stickers: true }),
}));
vi.mock('~/components/Sticker/sticker.util', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useOwnedSticker: () => ({ sticker: stickers, isLoading: false }),
}));
vi.mock('~/components/UserAvatar/UserHoverCard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useHoverCapable: () => mocks.hoverCapable,
}));
vi.mock('~/components/Sticker/sticker-attribution.util', () => ({
  useStickerAttribution: (id: number | null) => {
    mocks.attributionIds.push(id);
    return { sticker: id == null ? undefined : { creatorName: 'Ada Maker' }, isLoading: false };
  },
}));
vi.mock('~/components/EdgeMedia/EdgeImage', () => ({
  EdgeImage: ({ src, style, alt }: { src: string; style?: object; alt?: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} style={style} alt={alt} />
  ),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  trpc: makeTrpcProxy({
    'cosmetic.getStickerBalances': {
      useQuery: () => ({
        data: [
          { cosmeticId: 1, remaining: 3 },
          { cosmeticId: 2, remaining: null },
        ],
        isLoading: false,
      }),
    },
  }),
}));

const { StickerPicker } = await import('~/components/Sticker/StickerPicker');

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function openPicker(surface: 'comment' | 'chat', onSelect = vi.fn()) {
  await page.viewport(390, 844);
  renderWithProviders(
    <div style={{ padding: '330px 8px 0' }}>
      <StickerPicker
        surface={surface}
        position="top-start"
        onSelect={onSelect}
        // Chat passes no emoji handler, so it opens straight onto the stickers.
        {...(surface === 'comment' ? { onSelectEmoji: vi.fn() } : {})}
      />
    </div>
  );
  await page.getByLabelText('Insert sticker').click();
  if (surface === 'comment') await page.getByRole('tab', { name: 'Stickers' }).click();
  return onSelect;
}

const tile = (slug: string) => document.querySelector(`button[aria-label^=":${slug}:"]`)!;
const preview = () => document.querySelector('[data-testid="sticker-preview"]');

beforeEach(() => {
  mocks.hoverCapable = true;
  mocks.attributionIds.length = 0;
});

describe('StickerPicker tiles', () => {
  test('stickers are drawn large enough to recognize', async () => {
    await openPicker('comment');
    const img = tile('happy_frog').querySelector('img')!;
    expect(img.getBoundingClientRect().width).toBeGreaterThanOrEqual(56);
  });

  test('hovering a sticker shows it large, with its name, creator and balance', async () => {
    await openPicker('comment');
    expect(preview()).toBeNull();
    await userEvent.hover(tile('happy_frog'));
    await expect.poll(preview, { timeout: 2000 }).not.toBeNull();
    const card = preview()!;
    expect(card.querySelector('img')!.getBoundingClientRect().width).toBeGreaterThanOrEqual(120);
    expect(card.textContent).toContain('Happy Frog');
    expect(card.textContent).toContain('by Ada Maker');
    expect(card.textContent).toContain('3 left');
    // Plain text: the picker is for choosing, not a route to a shop.
    expect(card.querySelector('a')).toBeNull();
  });

  test('in chat the preview has no creator and never asks who made it', async () => {
    await openPicker('chat');
    await userEvent.hover(tile('happy_frog'));
    await expect.poll(preview, { timeout: 2000 }).not.toBeNull();
    expect(preview()!.textContent).toContain('Happy Frog');
    expect(preview()!.textContent).not.toContain('Ada Maker');
    expect(mocks.attributionIds.every((id) => id === null)).toBe(true);
  });

  test('a tap inserts the sticker', async () => {
    const onSelect = await openPicker('chat');
    await tile('sad_cat').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
  });

  test('a long press previews instead of inserting', async () => {
    mocks.hoverCapable = false;
    const onSelect = await openPicker('comment');
    expect(document.body.textContent).toContain('Press and hold a sticker to preview');
    const el = tile('happy_frog');
    el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true }));
    await settle(600);
    expect(preview()!.textContent).toContain('Happy Frog');
    el.dispatchEvent(new TouchEvent('touchend', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await expect.poll(preview, { timeout: 1000 }).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  test('scrolling (touchmove) before the hold completes does not open a preview', async () => {
    mocks.hoverCapable = false;
    await openPicker('comment');
    const el = tile('happy_frog');
    el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true }));
    el.dispatchEvent(new TouchEvent('touchmove', { bubbles: true }));
    await settle(600);
    expect(preview()).toBeNull();
  });
});
