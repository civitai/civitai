import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { getRandomId } from '~/utils/string-helpers';
import clsx from 'clsx';
import { useAdsContext } from '~/components/Ads/Playwire/AdsProvider';
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
  hideOnBlocked,
}: {
  children: React.ReactElement;
  browsingLevel?: number;
  hideOnBlocked?: boolean;
}) {
  const { adsEnabled, adsBlocked } = useAdsContext();
  const browsingLevel = useBrowsingLevelDebounced();
  const nsfw = !getIsSafeBrowsingLevel(browsingLevelOverride ?? browsingLevel);

  if (!adsEnabled || nsfw) return null;
  if (hideOnBlocked && adsBlocked) return null;

  return children;
}

function getTypeFromSelectorId(selectorId: string) {
  const units: Record<string, { element: HTMLElement }> = window.ramp.settings.slots;
  return Object.entries(units).find(
    ([_, value]) => value.element.getAttribute('data-selector-id') === selectorId
  )?.[0];
}

function AdunitDynamic({
  id,
  type,
  className,
  onImpressionTracked,
}: {
  id?: string;
  type: string;
  className?: string;
  onImpressionTracked?: (type: string) => void;
}) {
  const [selectorId] = useState(id ?? getRandomId());

  useEffect(() => {
    window.ramp.spaAddAds([{ type, selectorId }]);

    return () => {
      const type = getTypeFromSelectorId(selectorId);
      if (type) {
        console.log('destroying adunit', type, selectorId);
        window.ramp.destroyUnits([type]);
      }
    };
  }, [selectorId, type]);

  useEffect(() => {
    if (!onImpressionTracked) return;
    const listener = ((e: CustomEvent) => {
      const type = getTypeFromSelectorId(selectorId);
      console.log({ detail: e.detail, type });
      if (type && e.detail === type) onImpressionTracked?.(type);
    }) as EventListener;
    window.addEventListener('civitai-ad-impression', listener);
    return () => {
      window.removeEventListener('civitai-ad-impression', listener);
    };
  }, [onImpressionTracked]);

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
    <div className={className}>
      <NextLink href="/pricing">
        <Image
          src={`/images/support-us/${supportUsSize}.jpg`}
          alt="Please support civitai and creators by disabling adblock"
          width={width}
          height={height}
          className="rounded-md"
        />
      </NextLink>
    </div>
  );
}

type AdunitProps = {
  id?: string;
  browsingLevel?: number;
  className?: string;
  onImpressionTracked?: (type: string) => void;
  hideOnBlocked?: boolean;
};
export function createAdunit({
  type,
  className,
  supportUsSize,
}: {
  type: string;
  className?: string;
  supportUsSize?: SupportUsImageSize;
}) {
  return function Adunit(props: AdunitProps) {
    const { adsBlocked, ready } = useAdsContext();
    return (
      <AdUnitRenderable browsingLevel={props.browsingLevel} hideOnBlocked={props.hideOnBlocked}>
        <div className={props.className}>
          {!ready ? null : !adsBlocked ? (
            <AdunitDynamic
              id={props.id}
              type={type}
              className={clsx(className)}
              onImpressionTracked={props.onImpressionTracked}
            />
          ) : supportUsSize ? (
            <SupportUsImage supportUsSize={supportUsSize} className={clsx(className)} />
          ) : null}
        </div>
      </AdUnitRenderable>
    );
  };
}

export function createAdunitLUT(
  lut: { minWidth?: number; component: React.ComponentType<AdunitProps> }[]
) {
  const lutReversed = lut.reverse();
  return function AdunitLUT(props: AdunitProps) {
    const { nodeRef, containerName } = useContainerContext();
    const Component = useContainerProviderStore(
      useCallback((state) => {
        const containerWidth =
          state[containerName]?.inlineSize ?? nodeRef.current?.offsetWidth ?? 0;
        const match = lutReversed.find(({ minWidth = 0 }) => minWidth <= containerWidth);
        return match?.component ?? null;
      }, [])
    );

    return Component ? <Component {...props} /> : null;
  };
}
