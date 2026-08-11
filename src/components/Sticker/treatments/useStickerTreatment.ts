import { useRouter } from 'next/router';
import {
  DEFAULT_STICKER_TREATMENT,
  isStickerTreatmentKey,
  type StickerTreatmentKey,
} from '~/components/Sticker/treatments/sticker-treatments';

/**
 * Which treatment the placed stickers on this page draw with.
 *
 * `?stickerTreatment=dieCut` overrides it **in development only**, so the four
 * candidates can be compared on real content in their real surfaces rather than
 * on a mock. In any other build this returns the compiled default and the query
 * parameter does nothing, which is what keeps a debug affordance out of
 * production without a second flag to remember to turn off.
 */
export function useStickerTreatment(): StickerTreatmentKey {
  const router = useRouter();

  if (process.env.NODE_ENV !== 'development') return DEFAULT_STICKER_TREATMENT;

  const requested = router.query.stickerTreatment;
  const value = Array.isArray(requested) ? requested[0] : requested;

  return isStickerTreatmentKey(value) ? value : DEFAULT_STICKER_TREATMENT;
}
