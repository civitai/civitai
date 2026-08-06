import { useEffect } from 'react';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import { useOwnedSticker } from '~/components/Sticker/sticker.util';
import type { StickerInteraction } from '~/store/sticker-placement-draft.store';
import {
  pointerToSurfaceFraction,
  useStickerPlacementDraftStore,
} from '~/store/sticker-placement-draft.store';

/** Where the rotate knob sits above the sticker, as a fraction of its height. */
const KNOB_OFFSET = 0.22;

/**
 * The sticker being positioned, drawn in the image's own media box and dragged
 * directly — no modal, no second copy of the image.
 *
 * Drag the body to move, a corner to resize, the knob above it to rotate. The
 * handles are the affordance people already know from every other editor, which
 * is the whole reason not to ship sliders.
 *
 * Every interaction is measured against the live media box, so the numbers
 * written are fractions of it and survive the image being drawn at any other
 * size later.
 */
export function DraftStickerLayer() {
  const draft = useStickerPlacementDraftStore((state) => state.draft);
  const move = useStickerPlacementDraftStore((state) => state.move);
  const setInteraction = useStickerPlacementDraftStore((state) => state.setInteraction);
  const { sticker } = useOwnedSticker();

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      // Read through getState rather than subscribing: this listener runs on
      // every pointer move, and re-binding it whenever the interaction changes
      // would drop the moves that land during the swap.
      const interaction = useStickerPlacementDraftStore.getState().interaction;
      if (!interaction) return;
      const point = pointerToSurfaceFraction(event.clientX, event.clientY);
      if (!point) return;

      const current = useStickerPlacementDraftStore.getState().draft;
      if (!current) return;

      if (interaction === 'move') {
        move({ x: point.x, y: point.y });
        return;
      }

      // Resize and rotate are both measured from the sticker's centre, in
      // pixels, because the box is not square — doing it in fractions would make
      // a drag along x behave differently from the same drag along y.
      const centreX = current.x * point.bounds.width;
      const centreY = current.y * point.bounds.height;
      const dx = event.clientX - point.bounds.left - centreX;
      const dy = event.clientY - point.bounds.top - centreY;

      if (interaction === 'rotate') {
        // The knob sits above the sticker, so straight up is zero rather than
        // atan2's zero, which points right.
        move({ rotation: (Math.atan2(dy, dx) * 180) / Math.PI + 90 });
        return;
      }

      // Undo the sticker's own rotation before measuring, so dragging a corner
      // of a rotated sticker still grows it along its own edge rather than the
      // screen's.
      const radians = (-current.rotation * Math.PI) / 180;
      const localX = dx * Math.cos(radians) - dy * Math.sin(radians);
      move({ scale: (Math.abs(localX) * 2) / point.bounds.width });
    };

    const onUp = () => setInteraction(null);

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [move, setInteraction]);

  if (!draft) return null;

  const art = sticker.find((option) => option.id === draft.cosmeticId);
  if (!art) return null;

  const start = (next: StickerInteraction) => (event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setInteraction(next);
  };

  const handle = (position: string) => (
    <span
      key={position}
      onPointerDown={start('resize')}
      className={`absolute size-3 cursor-nwse-resize rounded-full border-2 border-white bg-blue-5 ${position}`}
    />
  );

  return (
    <div
      className="pointer-events-auto absolute cursor-move"
      style={{
        left: `${draft.x * 100}%`,
        top: `${draft.y * 100}%`,
        width: `${draft.scale * 100}%`,
        transform: `translate(-50%, -50%) rotate(${draft.rotation}deg)`,
        touchAction: 'none',
      }}
      onPointerDown={start('move')}
    >
      <EdgeImage
        src={art.url}
        alt={`:${art.slug}:`}
        options={{ width: 512, anim: art.animated, optimized: true }}
        style={{ width: '100%', height: 'auto', display: 'block', pointerEvents: 'none' }}
        draggable={false}
      />

      <span className="pointer-events-none absolute inset-0 border-2 border-dashed border-blue-5" />

      {[
        '-left-1.5 -top-1.5',
        '-right-1.5 -top-1.5',
        '-bottom-1.5 -left-1.5',
        '-bottom-1.5 -right-1.5',
      ].map(handle)}

      <span
        onPointerDown={start('rotate')}
        className="absolute left-1/2 size-4 -translate-x-1/2 cursor-grab rounded-full border-2 border-white bg-blue-5"
        style={{ top: `-${KNOB_OFFSET * 100}%` }}
      />
    </div>
  );
}
