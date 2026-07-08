import { AdUnitAdhesive } from '~/components/Ads/AdUnit';
import { useState } from 'react';
import { IconX } from '@tabler/icons-react';
import { AdUnitRenderable } from '~/components/Ads/AdUnitRenderable';
import { useAdsContext } from '~/components/Ads/AdsProvider';
import { NextLink } from '~/components/NextLink/NextLink';
import { isMobileDevice } from '~/hooks/useIsMobile';
// import { useContainerLargerThan } from '~/components/ContainerProvider/useContainerLargerThan';

function AdhesiveAdContent({
  onClose,
  preserveLayout = false,
}: {
  onClose?: () => void;
  preserveLayout?: boolean;
}) {
  const isMobile = isMobileDevice();
  const tracked = AdUnitAdhesive.useImpressionTracked();
  const { adsBlocked } = useAdsContext();
  // The blocked placeholder never fires an impression, so gate its close button
  // on adsBlocked instead of tracking; real ads still wait for tracking (desktop only).
  const canClose = adsBlocked || (tracked && !isMobile);

  return (
    // No hideOnBlocked: when ads are blocked we render a CSS/text placeholder
    // instead (an <img> placeholder gets eaten by blockers too), sized to match
    // the ad so the footer neither goes blank nor shifts.
    <AdUnitRenderable>
      <div className="relative flex justify-center border-t border-gray-3 bg-gray-2 dark:border-dark-4 dark:bg-dark-9">
        {adsBlocked ? (
          <NextLink
            href="/pricing"
            className="flex w-full items-center justify-center px-12 text-center text-xs leading-tight text-gray-7 dark:text-dark-1 sm:text-sm"
            style={{ height: isMobile ? 50 : 90 }}
          >
            Civitai memberships — more features, fewer limits.
          </NextLink>
        ) : (
          <AdUnitAdhesive maxHeight={90} preserveLayout={preserveLayout} />
        )}
        {canClose && onClose && (
          <button
            className="absolute inset-y-0 right-0 flex w-9 items-center justify-center bg-gray-0/50 dark:bg-dark-6/50"
            onClick={onClose}
            aria-label="Close ad"
          >
            {isMobile ? (
              <IconX size={18} />
            ) : (
              <div className="inline-block -rotate-90 text-nowrap">Close Ad</div>
            )}
          </button>
        )}
      </div>
    </AdUnitRenderable>
  );
}

export function AdhesiveAd({
  closeable,
  preserveLayout,
}: {
  closeable?: boolean;
  preserveLayout?: boolean;
}) {
  const [closed, setClosed] = useState(false);

  if (closed) return null;

  return (
    <AdhesiveAdContent
      onClose={closeable !== false ? () => setClosed(true) : undefined}
      preserveLayout={preserveLayout}
    />
  );
}
