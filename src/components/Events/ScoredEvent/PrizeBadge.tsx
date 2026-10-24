import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useAutoplayGifs } from '~/providers/BrowserSettingsProvider';

/**
 * One team's prize badge. The animated file keeps its motion and transparency only on an optimized
 * variant (a sized request); viewers with autoplay off get the still file instead.
 */
export function PrizeBadge({
  badge,
  width = 160,
  className,
}: {
  badge: { animated: string; static: string };
  /** Source width in px; about twice the displayed size. */
  width?: number;
  className?: string;
}) {
  const autoplay = useAutoplayGifs();
  return (
    <EdgeMedia
      src={autoplay ? badge.animated : badge.static}
      width={width}
      className={className}
      loading="lazy"
      alt=""
    />
  );
}
