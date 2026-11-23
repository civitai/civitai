import clsx from 'clsx';
import type { CSSProperties } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import type { SidebarBackgroundCosmetic } from '~/server/selectors/cosmetic.selector';

// Fixed by us, not the cosmetic: the art fades out at the bottom into whatever the sidebar's card
// colour is, so it reads the same on any card.
const bottomFade = 'linear-gradient(to bottom, black 45%, transparent)';
const fadeStyle: CSSProperties = { maskImage: bottomFade, WebkitMaskImage: bottomFade };

/** A `SidebarBackground` cosmetic's art; the caller positions and sizes it. */
export function SidebarBackgroundArt({
  data,
  className,
  loading,
}: {
  data: SidebarBackgroundCosmetic['data'];
  className?: string;
  loading?: 'lazy';
}) {
  if (!data.url) return null;

  return (
    <div
      aria-hidden
      className={clsx('pointer-events-none overflow-hidden', className)}
      style={fadeStyle}
    >
      <EdgeMedia
        src={data.url}
        type={data.type ?? 'image'}
        alt=""
        anim
        // The sidebar is 320px wide; 450 covers it on a high-density screen, as the creator card does.
        width={450}
        optimized
        loading={loading}
        wrapperProps={{ style: { height: '100%' } }}
        style={{ width: '100%', maxWidth: '100%', height: '100%', objectFit: 'cover' }}
      />
    </div>
  );
}
