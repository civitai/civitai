import { AdUnitAdhesive } from '~/components/Ads/AdUnit';
import { useEffect, useState } from 'react';
import { AdUnitRenderable } from '~/components/Ads/AdUnitRenderable';
import { isMobileDevice } from '~/hooks/useIsMobile';

function AdhesiveAdContent({
  onClose,
  preserveLayout = false,
}: {
  onClose?: () => void;
  preserveLayout?: boolean;
}) {
  const [canClose, setCanClose] = useState(false);

  useEffect(() => {
    const isMobile = isMobileDevice();
    if (isMobile) return;
    const listener = ((e: CustomEvent) => {
      const adUnit = e.detail;
      if (adUnit === 'adhesive') {
        setTimeout(() => setCanClose(true), 1000);
      }
    }) as EventListener;

    window.addEventListener('civitai-ad-impression', listener);
    return () => {
      window.removeEventListener('civitai-ad-impression', listener);
    };
  }, []);

  return (
    <AdUnitRenderable hideOnBlocked>
      <div className="relative border-t border-gray-3 bg-gray-2 dark:border-dark-4 dark:bg-dark-9">
        <AdUnitAdhesive maxHeight={90} preserveLayout={preserveLayout} />
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
