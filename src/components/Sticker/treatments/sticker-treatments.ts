import type { CSSProperties } from 'react';
import styles from '~/components/Sticker/treatments/sticker-treatments.module.scss';

export const STICKER_TREATMENT_KEYS = ['none', 'lift', 'dieCut', 'plate', 'motion'] as const;

export type StickerTreatmentKey = (typeof STICKER_TREATMENT_KEYS)[number];

/**
 * Which surface is drawing. Not the same question as `interactive`, which
 * already means pointer-events, the hover card and the moderator remove action;
 * a detail view that turned those off would still want the detail treatment.
 */
export type StickerSurface = 'detail' | 'card';

export type StickerTreatment = {
  key: StickerTreatmentKey;
  label: string;
  note: string;
  /**
   * On the artwork itself, so anything silhouette-shaped follows the alpha
   * channel rather than the element's box. Keyed by surface because a card
   * draws a sticker at roughly half the width, and a px-denominated edge is
   * twice as heavy there.
   */
  imageStyle?: Partial<Record<StickerSurface, CSSProperties>>;
  /**
   * A plate drawn behind the artwork. Sized in percentages of the sticker so it
   * holds at card scale.
   */
  behind?: { className?: string; style?: CSSProperties };
  /** Wraps the artwork in an element this treatment animates. */
  animationClassName?: string;
};

const dieCutEdge = (px: number): CSSProperties => ({
  // Four zero-blur shadows are the only way to trace an alpha edge in CSS; an
  // outline or a border would trace the element's box instead.
  filter: [
    `drop-shadow(${px}px 0 0 #fff)`,
    `drop-shadow(-${px}px 0 0 #fff)`,
    `drop-shadow(0 ${px}px 0 #fff)`,
    `drop-shadow(0 -${px}px 0 #fff)`,
    'drop-shadow(0 3px 5px rgba(0, 0, 0, 0.45))',
  ].join(' '),
});

/**
 * Distinctness from *pending* is a constraint, not a preference: pending is 60%
 * opacity plus a dashed yellow outline, and a treatment that reads as pending
 * tells an owner they have a decision waiting that they do not. Every option
 * here stays fully opaque and uses no dashes and no yellow — enforced by
 * `sticker-treatments.test.ts` over both the inline styles here and the
 * stylesheet behind `animationClassName`, because a sixth option added later is
 * exactly when a rule that lives only in comments gets broken.
 */
export const STICKER_TREATMENTS: Record<StickerTreatmentKey, StickerTreatment> = {
  none: {
    key: 'none',
    label: 'None (today)',
    note: 'Ships as-is. The control for judging the other four.',
  },

  lift: {
    key: 'lift',
    label: 'Lift',
    note: 'Two stacked drop-shadows, a tight contact one and a soft cast one. Follows the alpha silhouette, so it lifts a cut-out shape rather than a rectangle.',
    imageStyle: {
      detail: {
        filter:
          'drop-shadow(0 1px 1px rgba(0, 0, 0, 0.55)) drop-shadow(0 6px 10px rgba(0, 0, 0, 0.4))',
      },
      card: {
        filter:
          'drop-shadow(0 1px 1px rgba(0, 0, 0, 0.55)) drop-shadow(0 4px 7px rgba(0, 0, 0, 0.4))',
      },
    },
  },

  dieCut: {
    key: 'dieCut',
    label: 'Die-cut',
    note: 'A solid white edge hugging the silhouette, the way a vinyl sticker is cut, plus one soft shadow to seat it. Half the edge width on a card, where the sticker is about half as wide — at one width it reads as a halo rather than a cut.',
    imageStyle: { detail: dieCutEdge(1.5), card: dieCutEdge(0.75) },
  },

  plate: {
    key: 'plate',
    label: 'Plate',
    note: 'Treats the background instead of the sticker: a blurred, darkened rounded square behind it, so the sticker sits on its own surface whatever the artwork does. The blur needs Safari 18+ or iOS 18+; below that it degrades to a flat tint with no blur.',
    behind: {
      className: 'absolute -inset-[9%] rounded-[22%]',
      style: {
        // Written out rather than `backdrop-blur-[3px]` and `bg-black/25`: this
        // repo has no browserslist, so autoprefixer's defaults add no
        // -webkit- prefix and the blur is silently dropped on iOS 17 and
        // below. The colour is spelled out because the repo remaps `black` to
        // #222, which is not what "black at 25%" reads as in a description.
        WebkitBackdropFilter: 'blur(3px)',
        backdropFilter: 'blur(3px)',
        backgroundColor: 'rgba(0, 0, 0, 0.25)',
      },
    },
  },

  motion: {
    key: 'motion',
    label: 'Motion',
    note: 'A pop on arrival and a slow sway. Detail view only — a card falls back to Lift. Honours prefers-reduced-motion.',
    imageStyle: {
      detail: { filter: 'drop-shadow(0 2px 4px rgba(0, 0, 0, 0.45))' },
      card: { filter: 'drop-shadow(0 2px 4px rgba(0, 0, 0, 0.45))' },
    },
    animationClassName: styles.motion,
  },
};

export const DEFAULT_STICKER_TREATMENT: StickerTreatmentKey = 'none';

/**
 * What a card renders for a treatment that animates.
 *
 * A card is a link the reader is aiming at, and movement under the cursor is a
 * target that moves. Animations also tick whether or not they are on screen,
 * so their cost grows with the length of the feed while a filter's does not —
 * but any multiplier is a function of how many cards you chose to measure, so
 * there is deliberately no number here.
 */
export const CARD_TREATMENT_FALLBACK: StickerTreatmentKey = 'lift';

export const isStickerTreatmentKey = (value: unknown): value is StickerTreatmentKey =>
  typeof value === 'string' && (STICKER_TREATMENT_KEYS as readonly string[]).includes(value);

/**
 * The treatment a single placement actually draws with.
 *
 * Pending is decided here rather than at the call site so the rule holds for
 * every surface and every future caller: a pending placement gets no treatment,
 * because it already has one.
 */
export function resolveTreatment({
  treatment,
  surface,
  isPending,
}: {
  treatment: StickerTreatmentKey;
  surface: StickerSurface;
  isPending: boolean;
}): StickerTreatment {
  if (isPending) return STICKER_TREATMENTS.none;

  const chosen = STICKER_TREATMENTS[treatment];
  if (surface === 'card' && chosen.animationClassName)
    return STICKER_TREATMENTS[CARD_TREATMENT_FALLBACK];

  return chosen;
}
