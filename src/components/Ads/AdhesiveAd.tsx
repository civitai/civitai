import { AdUnitAdhesive } from '~/components/Ads/AdUnit';
import { useState } from 'react';
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
  const canClose = tracked && !isMobile;
  const { adsBlocked } = useAdsContext();

  return (
    // No hideOnBlocked: when ads are blocked we render a CSS/text placeholder
    // instead (an <img> placeholder gets eaten by blockers too), sized to match
    // the ad so the footer neither goes blank nor shifts.
    <AdUnitRenderable>
      <div className="relative flex justify-center border-t border-gray-3 bg-gray-2 dark:border-dark-4 dark:bg-dark-9">
        {adsBlocked ? (
          <NextLink
            href="/pricing"
            className="flex w-full items-center justify-center px-10 text-center text-sm text-gray-7 dark:text-dark-1"
            style={{ minHeight: isMobile ? 50 : 90 }}
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
          >
            <div className="inline-block -rotate-90 text-nowrap">Close Ad</div>
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
