import { describe, expect, test, vi } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { box, renderAtViewport } from '../../../test/geometry-setup';
import { StickerMotionGuides } from '~/components/Sticker/StickerMotionGuides';
import type { ResolvedSticker } from '~/components/Sticker/sticker.util';
import type { StickerTrackKey } from '~/shared/utils/sticker-track';
import type { StickerDraft } from '~/store/sticker-placement-draft.store';

vi.mock('~/components/EdgeMedia/EdgeImage', () => ({
  EdgeImage: ({ style }: { style?: React.CSSProperties }) => (
    <div style={{ ...style, aspectRatio: '1' }} />
  ),
}));

const MEDIA = { left: 0, top: 0, width: 400, height: 200 };

const key = (t: number, overrides: Partial<StickerTrackKey>): StickerTrackKey => ({
  t,
  x: 0.5,
  y: 0.5,
  s: 0.25,
  r: 0,
  o: 1,
  ease: 'smooth',
  ...overrides,
});

const draft = (keys: StickerTrackKey[]) =>
  ({
    id: 'd1',
    imageId: 1,
    cosmeticId: 9,
    x: keys[0].x,
    y: keys[0].y,
    scale: keys[0].s,
    rotation: keys[0].r,
    flip: false,
    opacity: 1,
    motion: { on: true, keys },
  } as StickerDraft);

const art = { id: 9, url: 'x', slug: 's', animated: false } as unknown as ResolvedSticker;

const center = (el: Element) => {
  const b = box(el);
  return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
};

const renderGuides = (keys: StickerTrackKey[], playheadMs: number) =>
  renderAtViewport(
    <div
      style={{
        position: 'fixed',
        left: MEDIA.left,
        top: MEDIA.top,
        width: MEDIA.width,
        height: MEDIA.height,
      }}
    >
      <StickerMotionGuides draft={draft(keys)} art={art} playheadMs={playheadMs} />
    </div>,
    { width: 800, height: 600 }
  );

describe('the selected sticker’s movement drawn on a 400×200 media box', () => {
  const keys = [key(0, { x: 0.25, y: 0.25 }), key(2000, { x: 0.75, y: 0.75, s: 0.5, r: 45 })];

  test('the dotted path runs through every key, the middle one included', async () => {
    await renderGuides([keys[0], key(1000, { x: 0.9, y: 0.1 }), keys[1]], 0);
    const path = document.querySelector('[data-motion-path]')!;
    expect(box(path)).toMatchObject({ left: 100, top: 20, right: 360, bottom: 150 });
  });

  test('each key’s dot is centred on its point, in pixels of the box', async () => {
    await renderGuides(keys, 0);
    const dots = [...document.querySelectorAll('[data-motion-key]')];
    expect(dots.map(center)).toEqual([
      { x: 100, y: 50 },
      { x: 300, y: 150 },
    ]);
  });

  test('a ghost sits at every key but the one under the playhead, at that key’s size', async () => {
    await renderGuides(keys, 0);
    const ghosts = [...document.querySelectorAll('[data-motion-ghost]')];
    expect(ghosts.map((ghost) => ghost.getAttribute('data-motion-ghost'))).toEqual(['1']);
    expect(center(ghosts[0])).toEqual({ x: 300, y: 150 });
    // Half the box wide, as a scale of 0.5 is: square art 200 wide, turned 45°, spans 200√2.
    expect(box(ghosts[0]).width).toBeCloseTo(282.84, 0);
    expect(box(ghosts[0]).height).toBeCloseTo(282.84, 0);
  });

  test('on the last key the ghost moves to the first', async () => {
    await renderGuides(keys, 2000);
    const ghosts = [...document.querySelectorAll('[data-motion-ghost]')];
    expect(ghosts.map((ghost) => ghost.getAttribute('data-motion-ghost'))).toEqual(['0']);
    expect(center(ghosts[0])).toEqual({ x: 100, y: 50 });
  });
});
