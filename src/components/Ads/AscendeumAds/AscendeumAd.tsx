import { Center, Paper, PaperProps, Text } from '@mantine/core';
import { useDidUpdate } from '@mantine/hooks';
import React, { useEffect, useMemo, useRef } from 'react';
import { useAscendeumAdsContext } from '~/components/Ads/AscendeumAds/AscendeumAdsProvider';
import { AdUnitType, AdUnitBidSizes, AdUnitSize } from '~/components/Ads/ads.utils';
import { ascAdManager } from '~/components/Ads/AscendeumAds/client';
import { useContainerWidth } from '~/components/ContainerProvider/ContainerProvider';
import { useInView } from '~/hooks/useInView';
import Image from 'next/image';

type AdContentProps<T extends AdUnitType> = {
  adunit: T;
  bidSizes: string;
  nsfw?: boolean;
  style?: React.CSSProperties;
};
type AdProps<T extends AdUnitType> = Omit<AdContentProps<T>, 'bidSizes'> &
  PaperProps & {
    /** mobile first screen sizes (must specify 0 for mobile) */
    sizes: Record<number, AdUnitBidSizes<T>>;
  };

export function AscendeumAd<T extends AdUnitType>({
  adunit,
  nsfw,
  sizes,
  ...paperProps
}: AdProps<T>) {
  const [ref, inView] = useInView({ rootMargin: '200%' });
  const { ready, adsBlocked, nsfw: globalNsfw } = useAscendeumAdsContext();
  const _nsfw = nsfw ?? globalNsfw;
  const keys = useMemo(
    () =>
      Object.keys(sizes)
        .map(Number)
        .sort((a, b) => b - a),
    []
  );
  const containerWidth = useContainerWidth();

  const bidSizes = useMemo(() => {
    for (const key of keys) {
      if (containerWidth >= key) {
        const bidSizes = sizes[key];
        const normalized = (!Array.isArray(bidSizes[0]) ? [bidSizes] : bidSizes) as AdUnitSize<T>[];
        const [width, height] = normalized[0].split('x').map(Number);
        return {
          width,
          height,
          stringSizes: `[${normalized.map((sizes) => `[${sizes.replace('x', ',')}]`)}]`,
        };
      }
    }
  }, [containerWidth]);

  if (!bidSizes || !ready) return null;
  const { width, height, stringSizes } = bidSizes;
  const showAscendeumAd = !adsBlocked && inView && !_nsfw;
  const showAlternateAd = !adsBlocked && inView && _nsfw;

  return (
    <Paper ref={ref} component={Center} withBorder h={height} w={width} {...paperProps}>
      {adsBlocked && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <Image
            src={`/images/ad-placeholders/adblock/${width}x${height}.jpg`}
            alt="Please support civitai and creators by disabling adblock"
            width={width}
            height={height}
          />
        </>
      )}
      {showAscendeumAd && (
        <AscendeumAdContent adunit={adunit} bidSizes={stringSizes} style={{ height, width }} />
      )}
      {showAlternateAd && (
        <Image
          src={`/images/ad-placeholders/member/${width}x${height}.jpg`}
          alt="Please become a member to support creators today"
          width={width}
          height={height}
        />
      )}
    </Paper>
  );
}

function AscendeumAdContent<T extends AdUnitType>({ adunit, bidSizes, style }: AdContentProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const _adunit = `/21718562853/CivitAI/${adunit}`;

  // do we want each ad to have their own refreshInterval
  // should every add have a refresh interval?
  useEffect(() => {
    ascAdManager.processAdsOnPage([_adunit]);
  }, [_adunit]);

  useDidUpdate(() => {
    ascAdManager.refreshAdunits([_adunit]);
  }, [bidSizes]);

  useEffect(() => {
    return () => {
      // extra malarkey to handle strict mode side effects
      if (!ref.current) ascAdManager.destroyAdunits([_adunit]);
    };
  }, []);

  return (
    <div
      ref={ref}
      data-aaad="true"
      data-aa-adunit={_adunit}
      data-aa-sizes={bidSizes}
      style={{ overflow: 'hidden', ...style }}
    />
  );
}
