import { BoxProps, Center, Group, Paper, Stack, Text } from '@mantine/core';
import { useDidUpdate } from '@mantine/hooks';
import React, { useEffect, useMemo, useRef } from 'react';
import { useAdsContext } from '~/components/Ads/AdsProvider';
import {
  AdUnitType,
  AdUnitBidSizes,
  AdUnitSize,
  ascendeumExoclickSizeMap,
  exoclickSizes,
} from '~/components/Ads/ads.utils';
import { ascAdManager } from '~/components/Ads/AscendeumAds/client';
import { useContainerWidth } from '~/components/ContainerProvider/ContainerProvider';
import { useInView } from '~/hooks/useInView';
import Image from 'next/image';
import { useStackingContext } from '~/components/Dialog/dialogStore';
import { v4 as uuidv4 } from 'uuid';
import { NextLink } from '@mantine/next';
import { ExoclickAd } from '~/components/Ads/Exoclick/ExoclickAd';

type AdProps<T extends AdUnitType> = {
  adunit: T;
  nsfw?: boolean;
  showRemoveAds?: boolean;
  showFeedback?: boolean;
  /** mobile first screen sizes (must specify 0 for mobile) */
  sizes: Record<number, AdUnitBidSizes<T>>;
} & BoxProps;

export function AscendeumAd<T extends AdUnitType>({
  adunit,
  nsfw: nsfwOverride,
  sizes,
  showRemoveAds,
  showFeedback,
  ...boxProps
}: AdProps<T>) {
  const [ref, inView] = useInView({ rootMargin: '200%' });
  const { isCurrentStack } = useStackingContext();
  const {
    adsBlocked,
    nsfw: globalNsfw,
    showAds,
    username,
    ascendeumReady,
    exoclickReady,
  } = useAdsContext();
  const containerWidth = useContainerWidth();

  const nsfw = nsfwOverride ?? globalNsfw;
  const showAscendeumAd = ascendeumReady && !nsfw;
  const showAlternateAd = exoclickReady && nsfw;

  const keys = useMemo(
    () =>
      Object.keys(sizes)
        .map(Number)
        .sort((a, b) => b - a),
    []
  );

  const sizeData = useMemo(() => {
    for (const key of keys) {
      if (containerWidth >= key) {
        const bidSizes = sizes[key];
        const normalized = (!Array.isArray(bidSizes) ? [bidSizes] : bidSizes) as AdUnitSize<T>[];
        let size: string;
        if (showAlternateAd) {
          size = ascendeumExoclickSizeMap[normalized[0]] ?? normalized[0];
        } else {
          size = normalized[0];
        }
        const [width, height] = size.split('x').map(Number);
        return {
          width,
          height,
          size,
          bidSizes: `[${normalized.map((sizes) => `[${sizes.replace('x', ',')}]`)}]`,
        };
      }
    }
  }, [containerWidth, showAlternateAd]);

  if (!sizeData || !showAds) return null;
  const { width, height, size, bidSizes } = sizeData;
  const includeWrapper = showRemoveAds || showFeedback;
  const zoneId = exoclickSizes[size];

  const content = (
    <Paper ref={ref} component={Center} h={height} w={width} {...(!includeWrapper ? boxProps : {})}>
      {isCurrentStack && inView && (
        <>
          {adsBlocked ? (
            <NextLink href="/pricing">
              <Image
                src={`/images/support-us/${width}x${height}.jpg`}
                alt="Please support civitai and creators by disabling adblock"
                width={width}
                height={height}
              />
            </NextLink>
          ) : (
            <>
              {showAscendeumAd && <AscendeumAdContent adunit={adunit} bidSizes={bidSizes} />}
              {/* {showAlternateAd && (
                <NextLink href="/pricing">
                  <Image
                    src={`/images/become-a-member/${width}x${height}.jpg`}
                    alt="Please become a member to support creators today"
                    width={width}
                    height={height}
                  />
                </NextLink>
              )} */}
              {showAlternateAd &&
                (zoneId ? (
                  <ExoclickAd zoneId={zoneId} size={size} />
                ) : (
                  <NextLink href="/pricing">
                    <Image
                      src={`/images/support-us/${width}x${height}.jpg`}
                      alt="Please become a member to support creators today"
                      width={width}
                      height={height}
                    />
                  </NextLink>
                ))}
            </>
          )}
        </>
      )}
    </Paper>
  );

  return includeWrapper ? (
    <Stack spacing={0} {...boxProps} w={width} justify="center">
      {content}
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
    </Stack>
  ) : (
    content
  );
}

function AscendeumAdContent<T extends AdUnitType>({
  adunit,
  bidSizes,
}: {
  adunit: T;
  bidSizes: string;
}) {
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
      style={{ overflow: 'hidden' }}
    />
  );
}
