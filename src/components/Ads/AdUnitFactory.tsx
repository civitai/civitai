import { supportUsImageSizes } from '~/components/Ads/ads.utils';
import { Text } from '@mantine/core';
import React, { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import { useAdsContext } from '~/components/Ads/AdsProvider';
import Image from 'next/image';
import clsx from 'clsx';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import { AdUnitRenderable, useAdunitRenderableContext } from '~/components/Ads/AdUnitRenderable';
import { useInView } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { NextLink } from '~/components/NextLink/NextLink';
import { useAdUnitImpressionTracked } from '~/components/Ads/useAdUnitImpressionTracked';
import {
  useContainerContext,
  useContainerProviderStore,
} from '~/components/ContainerProvider/ContainerProvider';
import { useInView as useInViewStandalone } from 'react-intersection-observer';
import { env } from '~/env/client';
import { v4 as uuidv4 } from 'uuid';
import { isDev } from '~/env/other';
import { usePausableInterval } from '~/utils/timer.utils';
import { getMatchingPathname } from '~/shared/constants/pathname.constants';

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
    const id = initialId ?? uuidv4();
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
  const { adsBlocked, ready, isMember, consent } = useAdsContext();
  const { nsfw } = useAdunitRenderableContext();

  const adSizes = useAdSizes({ sizes, lutSizes, maxHeight, maxWidth });
  const [ref, inView] = useInView();

  if (adSizes && !adSizes.length) return null;

  const content = (
    <>
      {adsBlocked || !consent ? (
        <SupportUsImage sizes={adSizes ?? undefined} />
      ) : nsfw ? (
        <CivitaiAdUnit adUnit={adUnit} id={id} />
      ) : inView && ready && adSizes !== undefined ? (
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
      )}
    </>
  );

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

  // return (
  //   <div
  //     ref={ref}
  //     style={preserveLayout !== false ? adWrapperStyles : undefined}
  //     className={clsx({
  //       [styles.adWrapper]: preserveLayout !== false,
  //       ['relative box-content flex flex-col items-center justify-center gap-2']: true,
  //       className,
  //     })}
  //   >
  //     {inView && (
  //       <>
  //         {adsBlocked ? (
  //           <SupportUsImage sizes={adSizes ?? undefined} />
  //         ) : ready && adSizes !== undefined ? (
  //           <AdUnitContent
  //             // key={key}
  //             adUnit={adUnit}
  //             sizes={adSizes ?? undefined}
  //             id={id}
  //             onDismount={onDismount}
  //           />
  //         ) : null}
  //         {withFeedback && !isMember && (
  //           <div className="flex w-full justify-end">
  //             <Text
  //               component={NextLink}
  //               td="underline"
  //               href="/pricing"
  //               c="dimmed"
  //               size="xs"
  //               align="center"
  //             >
  //               Remove ads
  //             </Text>
  //           </div>
  //         )}
  //       </>
  //     )}
  //   </div>
  // );
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

const civitaiAdvertisingUrl = isDev ? 'http://localhost:5173' : 'https://advertising.civitai.com';
function CivitaiAdUnit(props: { adUnit: string; id?: string }) {
  const [id, setId] = useState(props.id);
  const [imgLoaded, setImgLoaded] = useState(false);
  const { nodeRef } = useContainerContext();
  const node = useScrollAreaRef();
  const { browsingLevel } = useAdunitRenderableContext();
  const fetchingRef = React.useRef(false);
  const impressionRef = React.useRef(false);
  const [data, setData] = useState<{
    url: string;
    trace: string;
    cta?: string;
    nsfwLevel?: number;
    next?: boolean;
  } | null>(null);

  const { ref, inView } = useInViewStandalone({
    root: node?.current ?? nodeRef?.current ?? undefined,
    threshold: 0.5,
  });

  const traceRef = useRef<string>();
  const handleServe = useCallback(() => {
    const id = props.id ?? uuidv4();
    if (!props.id) setId(id);
    if (fetchingRef.current || document.visibilityState !== 'visible') return;
    fetchingRef.current = true;
    const type = adunitToCivitaiMap[props.adUnit];
    const searchParams = new URLSearchParams(
      `placement=${id}&name=${type}&container=${
        nodeRef.current?.clientWidth ?? 0
      }&browsingLevel=${browsingLevel}`
    );
    if (traceRef.current) searchParams.append('trace', traceRef.current);
    fetch(`${civitaiAdvertisingUrl}/api/v1/serve?${searchParams.toString()}`, {
      credentials: 'include',
    }).then(async (res) => {
      if (res.ok) {
        const data = await res.json();
        setData(data);
        traceRef.current = data.trace;
        fetchingRef.current = !data?.next;
      } else {
        fetchingRef.current = false;
      }
      impressionRef.current = false;
    });
  }, [browsingLevel, props.adUnit, props.id]);

  const interval = usePausableInterval(handleServe, 30 * 1000);

  useEffect(() => {
    if (inView && !data) handleServe();
  }, [inView, data, handleServe]);

  useEffect(() => {
    if (inView) interval.start();
    else interval.pause();
  }, [inView, handleServe, interval.start, interval.pause]);

  useEffect(() => {
    return () => {
      interval.stop();
    };
  }, [interval.stop]);

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible' && inView) {
        interval.start();
      } else {
        interval.pause();
      }
    }

    window.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [interval.start, interval.pause, inView]);

  useEffect(() => {
    function handleImpression() {
      if (impressionRef.current) return;
      if (imgLoaded && inView && data && document.visibilityState === 'visible') {
        impressionRef.current = true;
        fetch(`${civitaiAdvertisingUrl}/api/v1/view?trace=${data.trace}`, {
          method: 'POST',
          credentials: 'include',
          body: JSON.stringify({ pathname: getMatchingPathname(window.location.pathname) }),
          headers: {
            'Content-Type': 'application/json',
          },
        }).then(() => {
          window.dispatchEvent(
            new CustomEvent('civitai-custom-ad-impression', { detail: props.adUnit })
          );
        });
      }
    }

    const timeout = setTimeout(handleImpression, 1000);
    return () => {
      clearTimeout(timeout);
    };
  }, [imgLoaded, inView, data, props.adUnit]);

  return (
    <div id={id} ref={ref}>
      {data ? (
        <a
          target="_blank"
          href={`${civitaiAdvertisingUrl}/api/v1/engagement?trace=${data.trace}`}
          aria-label="visit advertiser"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`${env.NEXT_PUBLIC_IMAGE_LOCATION}/${data.url}/original=true/media.webp`}
            alt="advertisement"
            loading="lazy"
            onLoad={() => setImgLoaded(true)}
          />
        </a>
      ) : null}
    </div>
  );
}

const adunitToCivitaiMap: Record<string, string> = {
  incontent_1: 'feed',
  side_1: 'side_sky',
  side_2: 'side',
  side_3: 'side',
  top: 'banner',
  adhesive: 'footer',
};
