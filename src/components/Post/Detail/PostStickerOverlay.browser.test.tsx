import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as BatchProvider from '~/components/Sticker/StickerPlacementBatchProvider';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { LOADABLE_IMAGE_DATA_URI, renderWithProviders } from '../../../../test/component-setup';
import { PostStickerOverlay } from '~/components/Post/Detail/PostStickerOverlay';
import { useStickerRevealStore } from '~/store/sticker-reveal.store';

const IMAGE_ID = 1;

type Batch = ReturnType<typeof BatchProvider.useStickerPlacementBatch>;

const batchState: { value: Batch } = { value: null };

const placement = (id: number) => ({
  id,
  imageId: IMAGE_ID,
  isPending: false,
  data: { cosmeticId: 5, x: 0.5, y: 0.5, scale: 0.25, rotation: 0 },
});

// Spread the real module: a hand-listed mock couples this file to the whole
// transitive import graph of the provider, and nothing warns when that grows.
vi.mock('~/components/Sticker/StickerPlacementBatchProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BatchProvider>()),
  useStickerPlacementBatch: () => batchState.value,
}));

// Stubbed because the thing under test is the rectangle this component measures
// and hands down, not what the shared overlay draws inside it. The stub keeps the
// wrapper's box readable: its parent IS the measured element.
vi.mock('~/components/Sticker/StickerPlacementOverlay', () => ({
  StickerPlacementOverlay: ({ placements }: { placements: unknown[] }) => (
    <div data-testid="sticker-overlay">{placements.length}</div>
  ),
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 7 }) }));

/**
 * The post page's shape, reduced to the part that decides the geometry: a
 * positioned container whose only child is an INLINE anchor around the media.
 * The anchor is what makes the container taller than the image — a line box
 * reserves room for descenders under an inline image.
 */
function PostImageFixture() {
  return (
    <div data-testid="paper" style={{ position: 'relative', width: 400 }}>
      <a href="#">
        <img
          data-testid="media"
          src={LOADABLE_IMAGE_DATA_URI}
          alt=""
          style={{ width: '100%', height: 'auto', aspectRatio: '4 / 3' }}
        />
      </a>
      <PostStickerOverlay imageId={IMAGE_ID} />
    </div>
  );
}

const el = (testId: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`) ?? null;

const overlays = () => document.querySelectorAll('[data-testid="sticker-overlay"]').length;

describe('PostStickerOverlay', () => {
  beforeEach(() => {
    batchState.value = {
      count: 1,
      placements: [placement(1)],
      pending: [],
      sticker: new Map(),
      treatment: 'still',
    } as unknown as Batch;
    useStickerRevealStore.getState().setRevealed(true);
  });

  test('draws nothing while the reveal is off', async () => {
    useStickerRevealStore.getState().setRevealed(false);
    renderWithProviders(<PostImageFixture />);

    // The image is the absorbing state here — it is present from the first
    // paint and nothing removes it — so waiting on it is what proves the tree
    // rendered before counting overlays that should not be there.
    await vi.waitFor(() => expect(el('media')).not.toBeNull());
    expect(overlays()).toBe(0);
  });

  test('sizes the sticker layer to the media, not to the container around it', async () => {
    renderWithProviders(<PostImageFixture />);

    await vi.waitFor(() => expect(overlays()).toBe(1));

    const media = el('media');
    const paper = el('paper');
    const box = el('sticker-overlay')?.parentElement ?? null;
    expect(media).not.toBeNull();
    expect(paper).not.toBeNull();
    expect(box).not.toBeNull();

    // Control: without this the assertion below is vacuous, because measuring
    // and not measuring produce the same number whenever the two boxes agree.
    // This is the descender gap the measurement exists for.
    expect(paper!.offsetHeight).toBeGreaterThan(media!.offsetHeight);

    await vi.waitFor(() => {
      expect(box!.offsetWidth).toBe(media!.offsetWidth);
      expect(box!.offsetHeight).toBe(media!.offsetHeight);
    });
  });
});
