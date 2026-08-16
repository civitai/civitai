import { create } from 'zustand';
import {
  STICKER_PLACEMENT_DEFAULT_OPACITY,
  STICKER_PLACEMENT_DEFAULT_SCALE,
  STICKER_PLACEMENT_MAX_OPACITY,
  STICKER_PLACEMENT_MAX_ROTATION,
  STICKER_PLACEMENT_MAX_SCALE,
  STICKER_PLACEMENT_MIN_OPACITY,
  STICKER_PLACEMENT_MIN_SCALE,
} from '~/shared/utils/sticker-placement';

export type StickerInteraction = 'move' | 'resize' | 'rotate';

/**
 * What a draft dragged out of the shop still has to be paid for before it can be
 * placed. Absent on a sticker the placer already owns, which is every draft that
 * came out of the tray.
 */
export type DraftPurchase = {
  shopItemId: number;
  unitAmount: number;
  acceptsBlue: boolean;
  /** Attributes the sale to the storefront it came from, as the shop grids do. */
  viaShopUserId?: number;
  /** Who made the sticker, for the "this goes to" line on the purchase button. */
  creatorUsername?: string | null;
};

export type StickerDraft = {
  /**
   * Client-side identity. Not the cosmetic: the same sticker can be laid down
   * several times, so `cosmeticId` cannot tell two drafts apart, and index would
   * shift under every removal while a gesture holds a reference to one.
   */
  id: string;
  imageId: number;
  cosmeticId: number;
  /** Fractions of the rendered media box, same as a stored placement. */
  x: number;
  y: number;
  scale: number;
  rotation: number;
  flip: boolean;
  opacity: number;
  /** Set while this sticker is still unbought. Cleared by `markPurchased`. */
  purchase?: DraftPurchase;
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
  /**
   * Every sticker laid down but not yet bought, in the order they were laid.
   * Several at once because arranging a few and then deciding which to keep is
   * the way people actually use this — and because dragging a second one out
   * used to silently delete the first.
   */
  drafts: StickerDraft[];
  /**
   * Which one the handles, the rotate knob, the remove badge and the buy button
   * belong to. Exactly one, and never zero while any draft exists: N sets of
   * handles is unreadable, and N buy buttons would need to avoid each other —
   * a geometry problem that does not exist while only one is on screen.
   */
  selectedDraftId: string | null;
  /**
   * The image this placement session belongs to — NOT whether the tray is
   * showing. The two were one field, and it meant the panel could not be got out
   * of the way: the panel covers the bottom of the viewport, so a sticker aimed
   * near the bottom edge had nowhere to go, and closing the panel took the draft,
   * the layer drawing it and the coordinate surface with it.
   */
  targetImageId: number | null;
  /** Whether the panel is showing. A session outlives it. */
  trayOpen: boolean;
  surface: HTMLElement | null;
  /**
   * The tray element, for the one thing outside it that has to know where it is:
   * the buy button, which is drawn in the image's overlay and would otherwise be
   * painted over by it.
   */
  tray: HTMLElement | null;
  /**
   * What the pointer is currently doing, in the store rather than in the layer
   * that draws the handles — a drag can *start* in the tray, which is a
   * different subtree, and the sticker has to follow the same gesture that
   * picked it up rather than waiting to be grabbed a second time.
   */
  interaction: StickerInteraction | null;
  /**
   * The pointer that started a tray pickup, so the layer can hand the drag to
   * that same finger. Without it the layer would arm against whichever pointer
   * moved next, which on a touch screen is not necessarily the one holding the
   * sticker.
   */
  interactionPointerId: number | null;

  open: (imageId: number) => void;
  /** End the session outright — every draft, the panel and the target. */
  close: () => void;
  /** Put the panel away and leave the drafts on the image. */
  closeTray: () => void;
  /** Discard one draft, defaulting to the selected one. */
  cancelDraft: (id?: string) => void;
  select: (id: string) => void;
  setSurface: (element: HTMLElement | null) => void;
  setTray: (element: HTMLElement | null) => void;
  begin: (
    cosmeticId: number,
    at?: { x: number; y: number },
    maxScale?: number,
    purchase?: DraftPurchase
  ) => void;
  /**
   * The sticker has been bought. Clears the gate from EVERY draft of it, not
   * just the one whose button was pressed: one purchase grants the sticker, so
   * a second copy of it still asking to be bought would be selling it twice.
   */
  markPurchased: (cosmeticId: number) => void;
  setInteraction: (interaction: StickerInteraction | null, pointerId?: number) => void;
  /**
   * Moves one draft by id rather than "the current one". A gesture outlives the
   * selection — a press selects and then drags — so resolving the target at
   * every pointer move would let a selection change mid-drag redirect it.
   */
  move: (id: string, next: Partial<Omit<StickerDraft, 'id' | 'imageId' | 'cosmeticId'>>) => void;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

let draftSequence = 0;

/**
 * A draft's id, which never leaves the browser.
 *
 * Feature-detected rather than called directly: `crypto.randomUUID` is undefined
 * outside a secure context, so any http origin that is not localhost — a LAN dev
 * host, an http preview — would throw inside a zustand `set` called from a
 * pointermove handler, taking the whole placement flow down instead of
 * degrading. Same guard the rest of the repo uses on the client.
 *
 * The counter is a sound fallback precisely because these ids are local and
 * short-lived: they identify a draft within one page's session and are never
 * stored, sent, or compared against anything from elsewhere.
 */
const nextDraftId = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `draft-${++draftSequence}`;

const ENDED = {
  targetImageId: null,
  trayOpen: false,
  drafts: [] as StickerDraft[],
  selectedDraftId: null,
  interaction: null,
  interactionPointerId: null,
};

export const useStickerPlacementDraftStore = create<StickerPlacementDraftStore>((set) => ({
  drafts: [],
  selectedDraftId: null,
  targetImageId: null,
  trayOpen: false,
  surface: null,
  tray: null,
  interaction: null,
  interactionPointerId: null,

  // Reopening on the image you are already placing on keeps the drafts — that is
  // the way back to the panel after putting it away, so taking them would punish
  // using it.
  //
  // A different image is a different session, and starting one DISCARDS whatever
  // was arranged on the previous image. That is the intended behaviour, decided
  // by Justin rather than fallen into: moving on to the next image means giving
  // up the stickers you were applying to the last one. Note it is the *new
  // session* that discards them, not the navigation — the drafts survive
  // off-screen, so returning to the image before starting somewhere else brings
  // them and the panel back. Do not add a confirmation here without asking;
  // this looked like a silent-data-loss bug in review and is not one.
  //
  // Neither branch writes `interaction`. It mirrors whether the layer holds a
  // live gesture and only the layer may write it — the different-image branch
  // goes through ENDED, which nulls `targetImageId` and so unmounts the layer,
  // whose cleanup clears it. The same-image branch leaves the layer mounted, so
  // clearing here said "nothing is being dragged" while a finger still was:
  // press `+` with a second finger mid-drag and the tray would then allow a
  // pickup the layer refused to arm, leaving a sticker on the image that
  // followed nothing.
  open: (imageId) =>
    set((state) =>
      state.targetImageId === imageId
        ? { targetImageId: imageId, trayOpen: true }
        : { ...ENDED, targetImageId: imageId, trayOpen: true }
    ),

  close: () => set(ENDED),

  // A session with neither a panel nor a draft has nothing left to show, and
  // leaving `targetImageId` set would keep this image in placement mode — still
  // revealing pending placements, still holding the surface — with nothing on
  // screen to say so or to end it.
  closeTray: () => set((state) => (state.drafts.length ? { trayOpen: false } : ENDED)),

  cancelDraft: (id) =>
    set((state) => {
      const target = id ?? state.selectedDraftId;
      const drafts = state.drafts.filter((draft) => draft.id !== target);
      if (drafts.length === state.drafts.length) return state;
      if (!drafts.length && !state.trayOpen) return ENDED;

      return {
        drafts,
        // Selection follows the removal rather than emptying: the controls have
        // to land on something while any draft is left, or the remaining ones
        // are unreachable and there is no way to remove the next.
        selectedDraftId:
          state.selectedDraftId === target
            ? drafts[drafts.length - 1]?.id ?? null
            : state.selectedDraftId,
        // `interaction` is deliberately NOT cleared here. It mirrors whether the
        // layer holds a live gesture, and only the layer may write it — the tray
        // reads it to decide whether a pickup is allowed. Clearing it from here
        // said "no drag in progress" while a finger was still dragging something
        // else, which let a pickup through that the layer then refused to arm:
        // the new sticker landed on the image and never followed the pointer.
        // Removing a draft mid-drag is harmless without this — `move` already
        // ignores an id that is gone, and the gesture ends on its own pointerup.
      };
    }),

  select: (id) => set({ selectedDraftId: id }),

  setInteraction: (interaction, pointerId) =>
    set({ interaction, interactionPointerId: interaction ? pointerId ?? null : null }),
  setSurface: (element) => set({ surface: element }),
  setTray: (element) => set({ tray: element }),

  markPurchased: (cosmeticId) =>
    set((state) => ({
      drafts: state.drafts.map((draft) =>
        draft.cosmeticId === cosmeticId && draft.purchase
          ? { ...draft, purchase: undefined }
          : draft
      ),
    })),

  begin: (cosmeticId, at, maxScale, purchase) =>
    set((state) => {
      if (state.targetImageId == null) return state;

      const draft: StickerDraft = {
        ...(purchase ? { purchase } : {}),
        id: nextDraftId(),
        imageId: state.targetImageId,
        cosmeticId,
        x: at?.x ?? 0.5,
        y: at?.y ?? 0.5,
        // The creator's ceiling, not just the global one. A creator below the
        // 18% default is a third of the slider's range, and their space refused
        // the very first gesture with no hint why.
        scale: Math.min(STICKER_PLACEMENT_DEFAULT_SCALE, maxScale ?? STICKER_PLACEMENT_MAX_SCALE),
        rotation: 0,
        flip: false,
        opacity: STICKER_PLACEMENT_DEFAULT_OPACITY,
      };

      // Appended and selected: the one just dragged out is the one being placed,
      // and the drag that created it is already in flight against it.
      return { drafts: [...state.drafts, draft], selectedDraftId: draft.id };
    }),

  move: (id, next) =>
    set((state) => {
      const index = state.drafts.findIndex((draft) => draft.id === id);
      if (index < 0) return state;

      const current = state.drafts[index];
      const moved: StickerDraft = {
        ...current,
        ...next,
        x: clamp(next.x ?? current.x, 0, 1),
        y: clamp(next.y ?? current.y, 0, 1),
        scale: clamp(
          next.scale ?? current.scale,
          STICKER_PLACEMENT_MIN_SCALE,
          STICKER_PLACEMENT_MAX_SCALE
        ),
        rotation: clamp(
          next.rotation ?? current.rotation,
          -STICKER_PLACEMENT_MAX_ROTATION,
          STICKER_PLACEMENT_MAX_ROTATION
        ),
        // Clamped like the rest, though nothing here can overshoot: the slider is
        // bounded and the flip is a toggle. It matters because the server refuses
        // rather than clamps below the floor, so a draft that got there some other
        // way would be refused at the purchase — after the Buzz confirmation.
        opacity: clamp(
          next.opacity ?? current.opacity,
          STICKER_PLACEMENT_MIN_OPACITY,
          STICKER_PLACEMENT_MAX_OPACITY
        ),
      };

      // Replaced in place rather than moved to the end: order is what the drafts
      // are drawn in, and reordering on move would make a sticker jump over its
      // neighbours mid-drag.
      const drafts = [...state.drafts];
      drafts[index] = moved;
      return { drafts };
    }),
}));

/** The one carrying the handles and the buy button, if any. */
export const selectedDraft = (state: { drafts: StickerDraft[]; selectedDraftId: string | null }) =>
  state.drafts.find((draft) => draft.id === state.selectedDraftId) ?? null;

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
