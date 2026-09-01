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
        // 🔴 READ BY CSS, NOT BY JS. `globals.css` keys
        // `#__next:has([data-adhesive-ad])` off this attribute to zero
        // `--safe-area-inset-bottom-unpaid`, which is how `AppFooter` knows that
        // something below it is already paying. It has to sit on the BAR — the
        // element that actually pays — rather than on a wrapper, so that it
        // appears and disappears with the payment it stands for. Renaming it
        // silently returns the footer to paying as well (a 34px gap); the
        // ledger in viewport-fit-cover.test.ts pins the pair.
        data-adhesive-ad=""
        // This bar is the LAST flex child of the 100%-height `#__next` column, so
        // for every logged-out / free user it defines the viewport's bottom edge —
        // and it is not `position: fixed`, so no fixed/sticky audit finds it.
        //
        // The inset is added to `minHeight` as well as paid as padding: with the
        // global `box-sizing: border-box`, padding alone would eat the ad's own
        // 50/90px out of the same box. Together these keep exactly the 50/90px of
        // ad that was visible before `viewport-fit=cover`, now sitting above the
        // home indicator instead of partly behind it.
        style={{
          minHeight: `calc(${isMobile ? 50 : 90}px + var(--safe-area-inset-bottom))`,
          paddingBottom: 'var(--safe-area-inset-bottom)',
        }}
      >
        <AdUnitAdhesive maxHeight={90} preserveLayout={preserveLayout && !isMobile} />
        {canClose && onClose && (
          <button
            // `inset-y-0` would stretch the close button through the padding and
            // put its tap target under the home indicator. `right-0` is the same
            // mistake on the other axis: the bar spans the full width, so in
            // landscape this 36px-wide button sits entirely inside the ~47px
            // right cutout strip.
            className="absolute bottom-[var(--safe-area-inset-bottom)] right-[var(--safe-area-inset-right)] top-0 flex w-9 items-center justify-center bg-gray-0/50 dark:bg-dark-6/50"
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
