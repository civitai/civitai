import type { CSSProperties } from 'react';
import styles from '~/components/Sticker/treatments/sticker-treatments.module.scss';

export const STICKER_TREATMENT_KEYS = ['none', 'lift', 'dieCut', 'plate', 'motion'] as const;

export type StickerTreatmentKey = (typeof STICKER_TREATMENT_KEYS)[number];

export type StickerTreatment = {
  key: StickerTreatmentKey;
  label: string;
  note: string;
  /**
   * On the artwork itself, so anything silhouette-shaped follows the alpha
   * channel rather than the element's box.
   */
  imageStyle?: CSSProperties;
  /** On the positioned wrapper, which already owns the placement's transform. */
  wrapperStyle?: CSSProperties;
  /**
   * A plate drawn behind the artwork. Sized in percentages of the sticker so it
   * holds at card scale, where the sticker is a quarter of its detail size.
   */
  behind?: { className?: string; style?: CSSProperties };
  /** Wraps the artwork in an element this treatment animates. */
  animationClassName?: string;
};

/**
 * Distinctness from *pending* is a constraint, not a preference: pending is 60%
 * opacity plus a dashed yellow outline, and a treatment that reads as pending
 * tells an owner they have a decision waiting that they do not. Every option
 * here stays fully opaque and uses no dashes and no yellow, and the overlay
 * applies none of them to a pending placement.
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
    note: 'Two stacked drop-shadows: a tight contact shadow and a soft cast one. Follows the alpha silhouette, so it works on a cut-out shape rather than a rectangle.',
    imageStyle: {
      filter:
        'drop-shadow(0 1px 1px rgba(0, 0, 0, 0.55)) drop-shadow(0 6px 10px rgba(0, 0, 0, 0.4))',
    },
  },

  dieCut: {
    key: 'dieCut',
    label: 'Die-cut',
    note: 'A solid white border hugging the silhouette, the way a real vinyl sticker is cut, plus one soft shadow to seat it.',
    imageStyle: {
      // Four zero-blur shadows are the only way to trace an alpha edge in CSS;
      // an outline or border would trace the element's box instead. The offsets
      // are px, so the edge is proportionally heavier on a card than on the
      // detail view -- deliberate at these sizes, but it is the thing to look at
      // first if it reads wrong in a feed.
      filter: [
        'drop-shadow(1.5px 0 0 #fff)',
        'drop-shadow(-1.5px 0 0 #fff)',
        'drop-shadow(0 1.5px 0 #fff)',
        'drop-shadow(0 -1.5px 0 #fff)',
        'drop-shadow(0 3px 5px rgba(0, 0, 0, 0.45))',
      ].join(' '),
    },
  },

  plate: {
    key: 'plate',
    label: 'Plate',
    note: 'Treats the background instead of the sticker: a blurred, darkened disc behind it, so the sticker sits on its own surface whatever the artwork does.',
    behind: {
      className: 'absolute -inset-[9%] rounded-[22%] bg-black/25 backdrop-blur-[3px]',
    },
  },

  motion: {
    key: 'motion',
    label: 'Motion',
    note: 'A pop on arrival and a slow sway. Detail view only -- the overlay drops it to Lift on a card. Honours prefers-reduced-motion.',
    imageStyle: {
      filter: 'drop-shadow(0 2px 4px rgba(0, 0, 0, 0.45))',
    },
    animationClassName: styles.motion,
  },
};

export const DEFAULT_STICKER_TREATMENT: StickerTreatmentKey = 'none';

/**
 * What a feed card renders for a treatment that animates.
 *
 * ~50 cards each running an infinite transform animation is a different
 * proposition from one detail view, and the card is a link the reader is aiming
 * at -- movement under the cursor is a target that moves. The static treatment
 * keeps the distinctness without the cost.
 */
export const CARD_TREATMENT_FALLBACK: StickerTreatmentKey = 'lift';

export const isStickerTreatmentKey = (value: unknown): value is StickerTreatmentKey =>
  typeof value === 'string' && (STICKER_TREATMENT_KEYS as readonly string[]).includes(value);
