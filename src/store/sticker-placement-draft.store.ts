import { create } from 'zustand';
import {
  STICKER_PLACEMENT_DEFAULT_SCALE,
  STICKER_PLACEMENT_MAX_ROTATION,
  STICKER_PLACEMENT_MAX_SCALE,
  STICKER_PLACEMENT_MIN_SCALE,
} from '~/shared/utils/sticker-placement';

export type StickerInteraction = 'move' | 'resize' | 'rotate';

export type StickerDraft = {
  imageId: number;
  cosmeticId: number;
  /** Fractions of the rendered media box, same as a stored placement. */
  x: number;
  y: number;
  scale: number;
  rotation: number;
};

/**
 * The sticker being positioned, before it is paid for.
 *
 * A store rather than component state because the two halves of the interaction
 * live in different parts of the tree: the tray is fixed to the viewport and the
 * sticker is drawn inside the image's media box. Dragging from one to the other
 * is one gesture across both.
 *
 * `surface` is the media box element itself. Every coordinate here is a fraction
 * of that box, so a drag has to measure it live — the box changes with the
 * sidebar, the viewport and the carousel, and a cached rect silently offsets
 * every subsequent drag.
 */
interface StickerPlacementDraftStore {
  draft: StickerDraft | null;
  /** Open with a tray but nothing chosen yet. */
  targetImageId: number | null;
  surface: HTMLElement | null;
  /**
   * What the pointer is currently doing, in the store rather than in the layer
   * that draws the handles — a drag can *start* in the tray, which is a
   * different subtree, and the sticker has to follow the same gesture that
   * picked it up rather than waiting to be grabbed a second time.
   */
  interaction: StickerInteraction | null;

  open: (imageId: number) => void;
  close: () => void;
  setSurface: (element: HTMLElement | null) => void;
  begin: (cosmeticId: number, at?: { x: number; y: number }, maxScale?: number) => void;
  setInteraction: (interaction: StickerInteraction | null) => void;
  move: (next: Partial<Omit<StickerDraft, 'imageId' | 'cosmeticId'>>) => void;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export const useStickerPlacementDraftStore = create<StickerPlacementDraftStore>((set) => ({
  draft: null,
  targetImageId: null,
  surface: null,
  interaction: null,

  open: (imageId) => set({ targetImageId: imageId, draft: null, interaction: null }),
  close: () => set({ targetImageId: null, draft: null, interaction: null }),
  setInteraction: (interaction) => set({ interaction }),
  setSurface: (element) => set({ surface: element }),

  begin: (cosmeticId, at, maxScale) =>
    set((state) =>
      state.targetImageId == null
        ? state
        : {
            draft: {
              imageId: state.targetImageId,
              cosmeticId,
              x: at?.x ?? 0.5,
              y: at?.y ?? 0.5,
              // The creator's ceiling, not just the global one. A creator below
              // the 18% default is a third of the slider's range, and their
              // space refused the very first gesture with no hint why.
              scale: Math.min(STICKER_PLACEMENT_DEFAULT_SCALE, maxScale ?? STICKER_PLACEMENT_MAX_SCALE),
              rotation: 0,
            },
          }
    ),

  move: (next) =>
    set((state) =>
      !state.draft
        ? state
        : {
            draft: {
              ...state.draft,
              ...next,
              x: clamp(next.x ?? state.draft.x, 0, 1),
              y: clamp(next.y ?? state.draft.y, 0, 1),
              scale: clamp(
                next.scale ?? state.draft.scale,
                STICKER_PLACEMENT_MIN_SCALE,
                STICKER_PLACEMENT_MAX_SCALE
              ),
              rotation: clamp(
                next.rotation ?? state.draft.rotation,
                -STICKER_PLACEMENT_MAX_ROTATION,
                STICKER_PLACEMENT_MAX_ROTATION
              ),
            },
          }
    ),
}));

/**
 * Pointer position as a fraction of the media box.
 *
 * Measured live, never cached: the box moves with the sidebar, the viewport and
 * the carousel, and a stale rect silently offsets every later drag in a way that
 * reads as the sticker lagging the cursor.
 */
export function pointerToSurfaceFraction(clientX: number, clientY: number) {
  const surface = useStickerPlacementDraftStore.getState().surface;
  const bounds = surface?.getBoundingClientRect();
  if (!bounds?.width || !bounds.height) return null;

  return {
    x: clamp((clientX - bounds.left) / bounds.width, 0, 1),
    y: clamp((clientY - bounds.top) / bounds.height, 0, 1),
    bounds,
  };
}

/**
 * The same, but `null` when the pointer is outside the image rather than clamped
 * to its edge. Picking a sticker up from the tray happens *below* the image, and
 * clamping there would drop it on the bottom edge instead of somewhere sensible.
 */
export function pointerOverSurface(clientX: number, clientY: number) {
  const point = pointerToSurfaceFraction(clientX, clientY);
  if (!point) return null;
  const { bounds } = point;
  const inside =
    clientX >= bounds.left &&
    clientX <= bounds.right &&
    clientY >= bounds.top &&
    clientY <= bounds.bottom;
  return inside ? point : null;
}
