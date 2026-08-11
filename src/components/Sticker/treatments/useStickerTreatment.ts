import { useRouter } from 'next/router';
import {
  DEFAULT_STICKER_TREATMENT,
  isStickerTreatmentKey,
  STICKER_TREATMENTS,
  STILL_STICKER_TREATMENT,
  type StickerTreatmentKey,
} from '~/components/Sticker/treatments/sticker-treatments';
import { useCurrentUserSettings } from '~/components/UserSettings/hooks';

/**
 * Which treatment the placed stickers on this page draw with.
 *
 * `?stickerTreatment=dieCut` overrides it **in development only**, so the four
 * candidates can be compared on real content in their real surfaces rather than
 * on a mock. In any other build the query parameter does nothing, which is what
 * keeps a debug affordance out of production without a second flag to remember
 * to turn off.
 *
 * What it otherwise returns is the compiled default, or the still treatment when
 * the viewer has turned motion off.
 */
export function useStickerTreatment(): StickerTreatmentKey {
  const router = useRouter();
  const { disableStickerMotion } = useCurrentUserSettings();

  // Keyed on whether the default actually animates rather than on its name, so
  // changing the default to another animating treatment cannot quietly turn this
  // setting into one that writes, reads back and does nothing.
  //
  // It drops to the still treatment rather than to nothing: the point of a
  // treatment is that a sticker reads as a sticker, and someone who turned off
  // the movement did not ask to lose that.
  const animates = !!STICKER_TREATMENTS[DEFAULT_STICKER_TREATMENT].animationClassName;
  const preferred: StickerTreatmentKey =
    animates && disableStickerMotion ? STILL_STICKER_TREATMENT : DEFAULT_STICKER_TREATMENT;

  if (process.env.NODE_ENV !== 'development') return preferred;

  const requested = router.query.stickerTreatment;
  const value = Array.isArray(requested) ? requested[0] : requested;

  return isStickerTreatmentKey(value) ? value : preferred;
}
