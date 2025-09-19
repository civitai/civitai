import { supportUsImageSizes } from '~/components/Ads/ads.utils';
import { Text } from '@mantine/core';
import React, { forwardRef, useCallback, useEffect, useState } from 'react';
import { useAdsContext } from '~/components/Ads/AdsProvider';
import Image from 'next/image';
import { getRandomId } from '~/utils/string-helpers';
import clsx from 'clsx';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import { AdUnitRenderable } from '~/components/Ads/AdUnitRenderable';
import { useInView } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { NextLink } from '~/components/NextLink/NextLink';
import { useAdUnitImpressionTracked } from '~/components/Ads/useAdUnitImpressionTracked';
import {
  useContainerContext,
  useContainerProviderStore,
} from '~/components/ContainerProvider/ContainerProvider';

type AdSize = [width: number, height: number];
type ContainerSize = [minWidth?: number, maxWidth?: number];
type AdSizeLUT = [containerSize: ContainerSize, adSizes: AdSize[]];
type OnDismount = (adUnitId: string) => void;

const adUnitDictionary: Record<string, string> = {};

function AdUnitContent({
  adUnit,
  sizes,
  id: initialId,
  onDismount,
}: {
  adUnit: string;
  sizes?: AdSize[];
  id?: string;
  onDismount?: OnDismount;
}) {
  // const loadedRef = useRef(false);
  const [id, setId] = useState<string | null>(initialId ?? null);

  useEffect(() => {
    // if (loadedRef.current) return;
    // loadedRef.current = true;
    const id = initialId ?? getRandomId();
    setId(id);

    if (!adUnitDictionary[adUnit]) adUnitDictionary[adUnit] = id;

    if (window.adngin && window.adngin.adnginLoaderReady) {
      window.adngin.queue.push(() => {
        const payload = {
          adUnit,
          placement: id,
          gpIdUniquifier: adUnitDictionary[adUnit],
          sizes,
        };
        window.adngin.cmd.startAuction([payload]);
      });
    }

    return () => {
      window.googletag.cmd.push(function () {
        const slot = window.googletag
          .pubads()
          .getSlots()
          .find((x: any) => x.getSlotElementId() === id);
        if (slot) window.googletag.destroySlots([slot]);
      });
      onDismount?.(id);
    };
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
  className,
  id,
  maxHeight,
  maxWidth,
  preserveLayout,
  onDismount,
}: {
  adUnit: string;
  withFeedback?: boolean;
  className?: string;
  id?: string;
  sizes?: AdSize[] | null;
  lutSizes?: AdSizeLUT[];
  maxHeight?: number;
  maxWidth?: number;
  preserveLayout?: boolean;
  onDismount?: OnDismount;
}) {
  // const router = useRouter();
  // const key = router.asPath.split('?')[0];
  const { adsBlocked, ready } = useAdsContext();

  const adSizes = useAdSizes({ sizes, lutSizes, maxHeight, maxWidth });
  const [ref, inView] = useInView();

  if (adSizes && !adSizes.length) return null;

  const content = inView ? (
    <>
      <SupportUsImage sizes={adSizes ?? undefined} />
      {/* {adsBlocked ? (
        <SupportUsImage sizes={adSizes ?? undefined} />
      ) : ready && adSizes !== undefined ? (
        <AdUnitContent
          // key={key}
          adUnit={adUnit}
          sizes={adSizes ?? undefined}
          id={id}
          onDismount={onDismount}
        />
      ) : null}
      {withFeedback && !isMember && (
        <div className="flex w-full justify-end">
          <Text
            component={NextLink}
            td="underline"
            href="/pricing"
            c="dimmed"
            size="xs"
            align="center"
          >
            Remove ads
          </Text>
        </div>
      )} */}
    </>
  ) : null;

  const className2 = clsx(
    'relative box-content flex flex-col items-center justify-center gap-2',
    className
  );

  if (lutSizes) {
    return (
      <AdunitLutStyles
        ref={ref}
        lutSizes={lutSizes}
        maxHeight={maxHeight}
        maxWidth={maxWidth}
        className={className2}
        preserveLayout={preserveLayout}
      >
        {content}
      </AdunitLutStyles>
    );
  } else if (sizes) {
    return (
      <AdunitSizesStyles
        ref={ref}
        sizes={sizes}
        maxHeight={maxHeight}
        maxWidth={maxWidth}
        className={className2}
        preserveLayout={preserveLayout}
      >
        {content}
      </AdunitSizesStyles>
    );
  } else return null;
}

export function adUnitFactory(factoryArgs: {
  adUnit: string;
  sizes?: AdSize[] | null;
  lutSizes?: AdSizeLUT[];
  id?: string;
  onDismount?: OnDismount;
}) {
  function AdUnit({
    withFeedback,
    browsingLevel,
    className,
    maxHeight,
    maxWidth,
    preserveLayout,
  }: {
    withFeedback?: boolean;
    browsingLevel?: number;
    className?: string;
    maxHeight?: number;
    maxWidth?: number;
    preserveLayout?: boolean;
  }) {
    return (
      <AdUnitRenderable browsingLevel={browsingLevel}>
        <AdWrapper
          {...factoryArgs}
          withFeedback={withFeedback}
          className={className}
          maxHeight={maxHeight}
          maxWidth={maxWidth}
          preserveLayout={preserveLayout}
        />
      </AdUnitRenderable>
    );
  }

  AdUnit.useImpressionTracked = function () {
    return useAdUnitImpressionTracked(factoryArgs.adUnit);
  };

  return AdUnit;
}

function getMaxHeight(sizes: AdSize[], args?: { maxHeight?: number; maxWidth?: number }) {
  const { maxHeight, maxWidth } = args ?? {};
  const filteredSizes = maxWidth ? sizes.filter(([w]) => w <= maxWidth) : sizes;
  const height = Math.max(...filteredSizes.map(([_, height]) => Math.max(height)));
  return maxHeight ? Math.min(maxHeight, height) : height;
}

function useAdSizes({
  sizes,
  lutSizes,
  maxHeight,
  maxWidth,
}: {
  sizes?: AdSize[] | null;
  lutSizes?: AdSizeLUT[];
  maxHeight?: number;
  maxWidth?: number;
}) {
  const ref = useScrollAreaRef();
  const [adSizes, setAdSizes] = useState<AdSize[] | null | undefined>(undefined);

  useEffect(() => {
    function handleSetAdSizes(sizes: AdSize[] | null) {
      if (!sizes || (!maxHeight && !maxWidth)) setAdSizes(sizes);
      else
        setAdSizes(
          sizes.filter(([w, h]) => {
            if (maxHeight && h > maxHeight) return false;
            if (maxWidth && w > maxWidth) return false;
            return true;
          })
        );
    }

    if (sizes || sizes === null) handleSetAdSizes(sizes);
    else if (lutSizes) {
      const width = ref?.current?.clientWidth ?? window.innerWidth;
      const adSizes = lutSizes
        ?.filter(([[minWidth, maxWidth]]) => {
          if (minWidth && width < minWidth) return false;
          if (maxWidth && width > maxWidth) return false;
          return true;
        })
        .flatMap(([_, sizes]) => sizes);
      handleSetAdSizes(adSizes);
    }
  }, []);

  return adSizes;
}

const AdunitLutStyles = forwardRef<
  HTMLDivElement,
  {
    lutSizes: AdSizeLUT[];
    maxHeight?: number;
    maxWidth?: number;
    className?: string;
    children: React.ReactNode;
    preserveLayout?: boolean;
  }
>(({ className, children, lutSizes, maxHeight, maxWidth, preserveLayout = true }, ref) => {
  const { nodeRef, containerName } = useContainerContext();
  const sizes = useContainerProviderStore(
    useCallback((state) => {
      const inlineSize = state[containerName]?.inlineSize ?? nodeRef.current?.offsetWidth ?? 0;
      return lutSizes.find(([[minWidth, maxWidth]]) => {
        if (minWidth && inlineSize < minWidth) return false;
        if (maxWidth && inlineSize > maxWidth) return false;
        return true;
      })?.[1];
    }, [])
  );

  return (
    <div
      ref={ref}
      className={className}
      style={
        preserveLayout && sizes
          ? {
              minHeight: getMaxHeight(sizes, {
                maxHeight,
                maxWidth,
              }),
            }
          : undefined
      }
    >
      {children}
    </div>
  );
});

AdunitLutStyles.displayName = 'AdunitLutStyles';

const AdunitSizesStyles = forwardRef<
  HTMLDivElement,
  {
    sizes: AdSize[];
    maxHeight?: number;
    maxWidth?: number;
    className?: string;
    children: React.ReactNode;
    preserveLayout?: boolean;
  }
>(({ className, children, sizes, maxHeight, maxWidth, preserveLayout = true }, ref) => {
  return (
    <div
      ref={ref}
      className={className}
      style={
        preserveLayout
          ? {
              minHeight: getMaxHeight(sizes, {
                maxHeight,
                maxWidth,
              }),
            }
          : undefined
      }
    >
      {children}
    </div>
  );
});

AdunitSizesStyles.displayName = 'AdunitSizesStyles';
