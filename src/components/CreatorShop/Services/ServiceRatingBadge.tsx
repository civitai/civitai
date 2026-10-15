import { BrowsingLevelBadge } from '~/components/BrowsingLevel/BrowsingLevelBadge';
import { isMatureServiceRating } from '~/shared/constants/creator-service.constants';

/** Labels a mature (R and up) offering or deal; PG and PG-13 carry no badge (briony, 2026-10-15). */
export function ServiceRatingBadge({ rating }: { rating: number }) {
  if (!isMatureServiceRating(rating)) return null;
  return <BrowsingLevelBadge browsingLevel={rating} size="sm" radius="sm" className="shrink-0" />;
}
