import { useState } from 'react';
import { isMobileDevice } from '~/hooks/useIsMobile';
import { Adunit_Footer } from '~/components/Ads/Playwire/Adunit';
import { AdUnitRenderable } from '~/components/Ads/Playwire/AdUnitFactory';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useRouter } from 'next/router';

export function AdhesiveFooterAd() {
  const currentUser = useCurrentUser();
  const router = useRouter();
  const [tracked, setTracked] = useState(false);
  const [closed, setClosed] = useState(false);
  const isMobile = isMobileDevice();
  const canClose = tracked && !isMobile;

  function handleClose() {
    setClosed(true);
  }

  if (closed || currentUser?.isPaidMember || router.asPath.includes('/moderator')) return null;

  return (
    <AdUnitRenderable hideOnBlocked>
      <div className="relative flex justify-center border-t border-gray-3 bg-gray-2 dark:border-dark-4 dark:bg-dark-9">
        <Adunit_Footer onImpressionTracked={() => setTracked(true)} />
        {canClose && (
          <button
            className="absolute inset-y-0 right-0 flex w-9 items-center justify-center bg-gray-0/50 dark:bg-dark-6/50"
            onClick={handleClose}
          >
            <div className="inline-block -rotate-90 text-nowrap">Close Ad</div>
          </button>
        )}
      </div>
    </AdUnitRenderable>
  );
}
