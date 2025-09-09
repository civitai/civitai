import React, { useEffect, useState } from 'react';
import { getRandomId } from '~/utils/string-helpers';
import clsx from 'clsx';
import { useAdsContext } from '~/components/Ads/AdsProvider';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';

export function AdUnitRenderable({
  browsingLevel: browsingLevelOverride,
  children,
}: {
  browsingLevel?: number;
  children: React.ReactElement;
}) {
  const { adsEnabled, adsBlocked } = useAdsContext();
  const browsingLevel = useBrowsingLevelDebounced();
  const nsfw = !getIsSafeBrowsingLevel(browsingLevelOverride ?? browsingLevel);

  if (!adsEnabled || nsfw || adsBlocked) return null;

  return children;
}

function AdunitDynamic({ id, type, className }: { id?: string; type: string; className?: string }) {
  const [selectorId] = useState(id ?? getRandomId());

  useEffect(() => {
    window.ramp.spaAddAds([{ type, selectorId }]);
  }, [selectorId, type]);

  return <div className={className} id={selectorId} />;
}

export function createAdunit({ type, className }: { type: string; className?: string }) {
  return function Adunit(props: { id?: string; browsingLevel?: number; className?: string }) {
    return (
      <AdUnitRenderable browsingLevel={props.browsingLevel}>
        <AdunitDynamic id={props.id} type={type} className={clsx(className, props.className)} />
      </AdUnitRenderable>
    );
  };
}
