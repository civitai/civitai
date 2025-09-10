import React, { useCallback, useEffect, useState } from 'react';
import { getRandomId } from '~/utils/string-helpers';
import clsx from 'clsx';
import { useAdsContext } from '~/components/Ads/AdsProvider';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { NextLink } from '~/components/NextLink/NextLink';
import Image from 'next/image';
import {
  useContainerContext,
  useContainerProviderStore,
} from '~/components/ContainerProvider/ContainerProvider';

type SupportUsImageSize =
  | '120x600'
  | '300x100'
  | '300x250'
  | '300x600'
  | '320x50'
  | '320x100'
  | '728x90'
  | '970x90'
  | '970x250';

export function AdUnitRenderable({
  children,
  browsingLevel: browsingLevelOverride,
}: {
  children: React.ReactElement;
  browsingLevel?: number;
}) {
  const { adsEnabled } = useAdsContext();
  const browsingLevel = useBrowsingLevelDebounced();
  const nsfw = !getIsSafeBrowsingLevel(browsingLevelOverride ?? browsingLevel);

  if (!adsEnabled || nsfw) return null;

  return children;
}

function AdunitDynamic({ id, type, className }: { id?: string; type: string; className?: string }) {
  const [selectorId] = useState(id ?? getRandomId());

  useEffect(() => {
    window.ramp.spaAddAds([{ type, selectorId }]);

    return () => {
      const units: Record<string, { element: HTMLElement }> = window.ramp.settings.slots;
      const type = Object.entries(units).find(([_, value]) => value.element.id === selectorId)?.[0];
      if (type) {
        console.log('destroying adunit', type, selectorId);
        window.ramp.destroyUnits([type]);
      }
    };
  }, [selectorId, type]);

  return <div className={className} id={selectorId} />;
}

function SupportUsImage({
  supportUsSize,
  className,
}: {
  supportUsSize: SupportUsImageSize;
  className?: string;
}) {
  const [width, height] = supportUsSize.split('x').map(Number);
  return (
    <NextLink href="/pricing" className={className}>
      <Image
        src={`/images/support-us/${supportUsSize}.jpg`}
        alt="Please support civitai and creators by disabling adblock"
        width={width}
        height={height}
      />
    </NextLink>
  );
}

type AdunitProps = { id?: string; browsingLevel?: number; className?: string };
export function createAdunit({
  type,
  className,
  supportUsSize,
}: {
  type: string;
  className?: string;
  supportUsSize: SupportUsImageSize;
}) {
  return function Adunit(props: AdunitProps) {
    const { adsBlocked } = useAdsContext();
    return (
      <AdUnitRenderable browsingLevel={props.browsingLevel}>
        {adsBlocked ? (
          <SupportUsImage
            supportUsSize={supportUsSize}
            className={clsx(className, props.className)}
          />
        ) : (
          <AdunitDynamic id={props.id} type={type} className={clsx(className, props.className)} />
        )}
      </AdUnitRenderable>
    );
  };
}

export function createAdunitLUT(
  lut: { minWidth?: number; component: React.ComponentType<AdunitProps> }[]
) {
  return function AdunitLUT(props: AdunitProps) {
    const { nodeRef, containerName } = useContainerContext();
    const Component = useContainerProviderStore(
      useCallback((state) => {
        const containerWidth =
          state[containerName]?.inlineSize ?? nodeRef.current?.offsetWidth ?? 0;
        return (
          lut.reverse().find(({ minWidth = 0 }) => minWidth < containerWidth)?.component ?? null
        );
      }, [])
    );

    return Component ? <Component {...props} /> : null;
  };
}
