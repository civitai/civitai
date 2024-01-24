import { BoxProps, Center, Group, Paper, Stack, Text } from '@mantine/core';
import { useDidUpdate } from '@mantine/hooks';
import React, { useEffect, useMemo, useRef } from 'react';
import { useAscendeumAdsContext } from '~/components/Ads/AscendeumAds/AscendeumAdsProvider';
import {
  AdUnitType,
  AdUnitBidSizes,
  AdUnitSize,
  adsterraSizeMap,
  getAdsterraSize,
} from '~/components/Ads/ads.utils';
import { ascAdManager } from '~/components/Ads/AscendeumAds/client';
import { useContainerWidth } from '~/components/ContainerProvider/ContainerProvider';
import { useInView } from '~/hooks/useInView';
import Image from 'next/image';
import { useDialogStore, useStackingContext } from '~/components/Dialog/dialogStore';
import { v4 as uuidv4 } from 'uuid';
import { AdsterraAd } from '~/components/Ads/Adsterra/AdsterraAd';
import { NextLink } from '@mantine/next';
import { useCurrentUser } from '~/hooks/useCurrentUser';

type AdContentProps<T extends AdUnitType> = {
  adunit: T;
  bidSizes: string;
  nsfw?: boolean;
  style?: React.CSSProperties;
  showAdvertisementText?: boolean;
  showRemoveAds?: boolean;
  showFeedback?: boolean;
};
type AdProps<T extends AdUnitType> = Omit<AdContentProps<T>, 'bidSizes'> &
  BoxProps & {
    /** mobile first screen sizes (must specify 0 for mobile) */
    sizes: Record<number, AdUnitBidSizes<T>>;
  };

export function AscendeumAd<T extends AdUnitType>({
  adunit,
  nsfw,
  sizes,
  showAdvertisementText,
  showRemoveAds,
  showFeedback,
  ...boxProps
}: AdProps<T>) {
  const stackingContextRef = useRef(useStackingContext.getState().stackingContext.length);
  const currentUser = useCurrentUser();

  const [ref, inView] = useInView({ rootMargin: '200%' });
  const { ready, adsBlocked, nsfw: globalNsfw, showAds, username } = useAscendeumAdsContext();
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

  const showCurrentStack = useStackingContext(
    (state) => state.stackingContext.length === stackingContextRef.current
  );

  if (!bidSizes || !showAds) return null;
  const { width, height, stringSizes } = bidSizes;
  const _ready = ready && !adsBlocked && inView;
  const showAscendeumAd = _ready && !_nsfw;
  const showAlternateAd = _ready && _nsfw;
  const includeWrapper = showAdvertisementText || showRemoveAds;
  // const adsterraSize = showAlternateAd ? getAdsterraSize(`${width}x${height}`) : undefined;

  const content = (
    <Paper ref={ref} component={Center} h={height} w={width} {...(!includeWrapper ? boxProps : {})}>
      {showCurrentStack && (
        <>
          {adsBlocked && (
            <NextLink href="/pricing">
              <Image
                src={`/images/ad-placeholders/adblock/${width}x${height}.jpg`}
                alt="Please support civitai and creators by disabling adblock"
                width={width}
                height={height}
              />
            </NextLink>
          )}
          {showAscendeumAd && (
            <AscendeumAdContent adunit={adunit} bidSizes={stringSizes} style={{ height, width }} />
          )}
          {showAlternateAd && (
            // (adsterraSize ? (
            //   <AdsterraAd size={adsterraSize} />
            // ) : (
            //   <Image
            //     src={`/images/ad-placeholders/member/${width}x${height}.jpg`}
            //     alt="Please become a member to support creators today"
            //     width={width}
            //     height={height}
            //   />
            // ))}
            <NextLink href="/pricing">
              <Image
                src={`/images/ad-placeholders/member/${width}x${height}.jpg`}
                alt="Please become a member to support creators today"
                width={width}
                height={height}
              />
            </NextLink>
          )}
        </>
      )}
    </Paper>
  );

  return includeWrapper ? (
    <Stack spacing={0} {...boxProps} w={width}>
      {showAdvertisementText && (
        <Text color="dimmed" align="center" size="xs">
          Advertisement
        </Text>
      )}
      {content}
      {(showRemoveAds || showFeedback) && (
        <Group position="apart">
          {showRemoveAds && (
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
          )}
          {showFeedback && username && (
            <Text
              component={NextLink}
              td="underline"
              href={`/ad-feedback?Username=${username}&Ad unit=${adunit}`}
              color="dimmed"
              size="xs"
              align="center"
            >
              Feedback
            </Text>
          )}
        </Group>
      )}
    </Stack>
  ) : (
    content
  );
}

function AscendeumAdContent<T extends AdUnitType>({ adunit, bidSizes, style }: AdContentProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const _adunit = `/21718562853/CivitAI/${adunit}`;
  const idRef = useRef(uuidv4());

  // do we want each ad to have their own refreshInterval
  // should every add have a refresh interval?
  useEffect(() => {
    ascAdManager.processAdsOnPage([_adunit]);
  }, [_adunit]);

  useDidUpdate(() => {
    setTimeout(() => {
      ascAdManager.refreshIds([idRef.current]);
    }, 100);
  }, [bidSizes]);

  useEffect(() => {
    return () => {
      // extra malarkey to handle strict mode side effects
      if (!ref.current) {
        // console.log(`destroy ${_adunit}`);
        ascAdManager.destroyIds([idRef.current]);
      }
    };
  }, []);

  return (
    <div
      id={idRef.current}
      ref={ref}
      data-aaad="true"
      data-aa-adunit={_adunit}
      data-aa-sizes={bidSizes}
      style={{ overflow: 'hidden', ...style }}
    />
  );
}
