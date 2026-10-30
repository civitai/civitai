import { useTrackImpression } from '~/components/TrackView/useTrackImpression';
import type { ImpressionTarget } from '~/components/TrackView/useTrackImpression';

/**
 * Impression tracking for content with no single element to hang a ref on, such
 * as a carousel slide whose children are a fragment. It covers its nearest
 * positioned ancestor and takes no pointer events, so it changes neither layout
 * nor hit-testing. The parent must be `position: relative` (or otherwise
 * positioned), or the sentinel measures the wrong box.
 */
export function ImpressionSentinel({ impressions }: { impressions: ImpressionTarget[] }) {
  const ref = useTrackImpression<HTMLSpanElement>(impressions);
  return <span ref={ref} aria-hidden className="pointer-events-none absolute inset-0" />;
}
