import { AdUnitAdhesive } from '~/components/Ads/AdUnit';
import { useEffect, useState } from 'react';
import { IconX } from '@tabler/icons-react';
import { AdUnitRenderable } from '~/components/Ads/AdUnitRenderable';
import { useAdsContext } from '~/components/Ads/AdsProvider';
import { isMobileDevice } from '~/hooks/useIsMobile';

// Grace period before an unfilled ad is treated as failed and the bar becomes closeable.
// Long enough that a slow-but-valid ad still registers its impression first.
const LOAD_FALLBACK_DELAY = 10 * 1000;

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

  // If no impression registers within the grace period the ad failed to fill; let users close the
  // bar to reclaim the space (any device — a dead bar is worth freeing on mobile too).
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    if (tracked) return;
    const timeout = setTimeout(() => setLoadFailed(true), LOAD_FALLBACK_DELAY);
    return () => clearTimeout(timeout);
  }, [tracked]);

  // Blocked ads render the support-us placeholder (no impression), so allow closing immediately;
  // a filled ad waits for its tracked impression (desktop only); a failed ad falls back to loadFailed.
  const canClose = adsBlocked === true || loadFailed || (tracked && !isMobile);

  return (
    // The adhesive unit renders the support-us image itself when blocked; we just
    // reserve the bar height so the footer neither goes blank nor shifts.
    <AdUnitRenderable>
      <div
        className="relative flex justify-center border-t border-gray-3 bg-gray-2 dark:border-dark-4 dark:bg-dark-9"
        style={{ minHeight: isMobile ? 50 : 90 }}
      >
        <AdUnitAdhesive maxHeight={90} preserveLayout={preserveLayout} />
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
