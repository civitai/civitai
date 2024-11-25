import { supportUsImageSizes } from '~/components/Ads/ads.utils';
import { CSSObject, Text, createStyles } from '@mantine/core';
import React, { useEffect, useRef, useState } from 'react';
import { useAdsContext } from '~/components/Ads/AdsProvider';
import Image from 'next/image';
import { NextLink } from '@mantine/next';
import { getRandomId } from '~/utils/string-helpers';
import clsx from 'clsx';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import { AdUnitRenderable } from '~/components/Ads/AdUnitRenderable';

type AdSize = [width: number, height: number];
type ContainerSize = [minWidth?: number, maxWidth?: number];
type AdSizeLUT = [containerSize: ContainerSize, adSizes: AdSize[]];

const adUnitDictionary: Record<string, string> = {};

function AdUnitContent({
  adUnit,
  sizes,
  lazyLoad,
}: {
  adUnit: string;
  sizes?: AdSize[];
  lazyLoad?: boolean;
}) {
  const loadedRef = useRef(false);
  const [id, setId] = useState<string | null>(null);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    const id = getRandomId();
    setId(id);

    if (!adUnitDictionary[adUnit]) adUnitDictionary[adUnit] = id;

    if (window.adngin && window.adngin.adnginLoaderReady) {
      window.adngin.queue.push(() => {
        const payload = {
          adUnit,
          placement: id,
          gpIdUniquifier: adUnitDictionary[adUnit],
          lazyLoad,
          sizes,
        };
        window.adngin.cmd.startAuction([payload]);
      });
    }
  }, []);

  return id ? <div className="flex items-center justify-center" id={id}></div> : null;
}

function SupportUsImage({ sizes }: { sizes?: AdSize[] }) {
  const maxHeight = sizes ? getMaxHeight(sizes) : 0;
  const filtered = supportUsImageSizes
    .filter(([, height]) => height <= maxHeight)
    .sort(([, a], [, b]) => b - a);
  const match = filtered[0];
  if (!match) return null;
  const [width, height] = match;
  return (
    <NextLink href="/pricing" className="flex">
      <Image
        src={`/images/support-us/${width}x${height}.jpg`}
        alt="Please support civitai and creators by disabling adblock"
        width={width}
        height={height}
      />
    </NextLink>
  );
}

function AdWrapper({
  adUnit,
  sizes,
  lutSizes,
  withFeedback,
  lazyLoad,
  className,
}: {
  adUnit: string;
  sizes?: AdSize[];
  lutSizes?: AdSizeLUT[];
  withFeedback?: boolean;
  lazyLoad?: boolean;
  className?: string;
}) {
  const { adsBlocked, ready, isMember } = useAdsContext();

  const { classes } = useAdWrapperStyles({ sizes, lutSizes });
  const adSizes = useAdSizes({ sizes, lutSizes });

  return (
    <div
      className={clsx(
        classes.root,
        'relative box-content flex flex-col items-center justify-center gap-2',
        className
      )}
    >
      {adsBlocked ? (
        <SupportUsImage sizes={adSizes} />
      ) : ready ? (
        <AdUnitContent adUnit={adUnit} sizes={adSizes} lazyLoad={lazyLoad} />
      ) : null}
      {withFeedback && !isMember && (
        <>
          <div className="flex w-full justify-end">
            <Text
              component={NextLink}
              td="underline"
              href="/pricing"
              color="dimmed"
              size="xs"
              align="center"
            >
              Remove ads
            </Text>
          </div>
        </>
      )}
    </div>
  );
}

export function adUnitFactory(factoryArgs: {
  adUnit: string;
  sizes?: AdSize[];
  lutSizes?: AdSizeLUT[];
}) {
  return function AdUnit({
    lazyLoad,
    withFeedback,
    browsingLevel,
    className,
  }: {
    lazyLoad?: boolean;
    withFeedback?: boolean;
    browsingLevel?: number;
    className?: string;
  }) {
    return (
      <AdUnitRenderable browsingLevel={browsingLevel}>
        <AdWrapper
          {...factoryArgs}
          lazyLoad={lazyLoad}
          withFeedback={withFeedback}
          className={className}
        />
      </AdUnitRenderable>
    );
  };
}

function getMaxHeight(sizes: AdSize[]) {
  return Math.max(...sizes.map(([_, height]) => Math.max(height)));
}

const useAdWrapperStyles = createStyles(
  (theme, { sizes, lutSizes }: { sizes?: AdSize[]; lutSizes?: AdSizeLUT[] }) => ({
    root: {
      minHeight: sizes ? getMaxHeight(sizes) : undefined,
      ...lutSizes?.reduce<Record<string, CSSObject>>((acc, [[minWidth, maxWidth], sizes]) => {
        const queries: string[] = [];
        if (minWidth) queries.push(`(min-width: ${minWidth}px)`);
        if (maxWidth) queries.push(`(max-width: ${maxWidth}px)`);

        return {
          ...acc,
          [`@container ${queries.join(' and ')}`]: {
            minHeight: getMaxHeight(sizes),
          },
        };
      }, {}),
    },
  })
);

function useAdSizes({ sizes, lutSizes }: { sizes?: AdSize[]; lutSizes?: AdSizeLUT[] }) {
  const ref = useScrollAreaRef();
  const [adSizes, setAdSizes] = useState<AdSize[]>();

  useEffect(() => {
    if (sizes) setAdSizes(sizes);
    else if (lutSizes) {
      const width = ref?.current?.clientWidth ?? window.innerWidth;
      const adSizes = lutSizes
        ?.filter(([[minWidth, maxWidth]]) => {
          if (minWidth && width < minWidth) return false;
          if (maxWidth && width > maxWidth) return false;
          return true;
        })
        .flatMap(([_, sizes]) => sizes);
      setAdSizes(adSizes);
    }
  }, []);

  return adSizes;
}
