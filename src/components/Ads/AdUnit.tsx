import {
  AdSizes,
  AnyAdSize,
  AscendeumAdUnit,
  AscendeumAdUnitType,
  ExoclickAdUnit,
  adSizeImageMap,
} from '~/components/Ads/ads.utils';
import { Center, Group, Paper, PaperProps, Text, createStyles } from '@mantine/core';
import React, { useEffect, useMemo, useRef } from 'react';
import { useAdsContext } from '~/components/Ads/AdsProvider';
import { useContainerWidth } from '~/components/ContainerProvider/ContainerProvider';
import Image from 'next/image';
import { useIsLevelFocused, useStackingContext } from '~/components/Dialog/dialogStore';
import { NextLink } from '@mantine/next';
import { ExoclickAd } from '~/components/Ads/Exoclick/ExoclickAd';
import { AscendeumAd } from '~/components/Ads/AscendeumAds/AscendeumAd';
import { isDefined } from '~/utils/type-guards';
import { BrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import clsx from 'clsx';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useInView } from 'react-intersection-observer';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import { useIsClient } from '~/providers/IsClientProvider';
import { TwCard } from '~/components/TwCard/TwCard';
import { useSignalContext } from '~/components/Signals/SignalsProvider';
import { useDeviceFingerprint } from '~/hooks/useDeviceFingerprint';

type AdWrapperProps = Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> &
  AdSizes & {
    children: React.ReactNode | ((args: { isMobile: boolean }) => React.ReactNode);
    component?: 'div' | 'TwCard';
  };

function AdWrapper({
  children,
  className,
  width,
  height,
  style,
  component = 'div',
  ...props
}: AdWrapperProps) {
  const currentUser = useCurrentUser();
  const node = useScrollAreaRef();
  const isClient = useIsClient();
  const { adsBlocked, adsEnabled, isMember } = useAdsContext();
  const isMobile =
    typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
  // const focused = useIsLevelFocused();

  const { ref, inView } = useInView({
    root: node?.current,
    rootMargin: '200%',
  });

  if (!adsEnabled) return null;

  const Component = component === 'div' ? 'div' : TwCard;

  return (
    <Component
      ref={ref}
      className={clsx('flex flex-col items-center justify-between', className)}
      style={{ ...style, minHeight: height + 20, minWidth: width }}
      {...props}
    >
      {isClient && inView && adsBlocked !== undefined && (
        <>
          {adsBlocked ? (
            <NextLink href="/pricing" className="flex">
              <Image
                src={`/images/support-us/${width}x${height}.jpg`}
                alt="Please support civitai and creators by disabling adblock"
                width={width}
                height={height}
              />
            </NextLink>
          ) : typeof children === 'function' ? (
            children({ isMobile })
          ) : (
            children
          )}

          <div className="flex w-full justify-between">
            {!isMember ? (
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
            ) : (
              <div />
            )}

            {currentUser && (
              <Text
                component={NextLink}
                td="underline"
                href={`/ad-feedback?Username=${currentUser.username}`}
                color="dimmed"
                size="xs"
                align="center"
              >
                Feedback
              </Text>
            )}
          </div>
        </>
      )}
    </Component>
  );
}

function ImpressionTracker({
  children,
  adId,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { adId: string }) {
  const currentUser = useCurrentUser();
  const node = useScrollAreaRef();
  const { worker } = useSignalContext();
  const { fingerprint } = useDeviceFingerprint();
  const enterViewRef = useRef<Date>();
  const impressionTrackedRef = useRef<boolean>();
  const trackImpressionRef = useRef<VoidFunction>();
  if (!trackImpressionRef.current) {
    trackImpressionRef.current = function () {
      const enterDate = enterViewRef.current;
      const exitDate = new Date();
      if (worker && enterDate && currentUser && !impressionTrackedRef.current) {
        const diff = exitDate.getTime() - enterDate.getTime();
        if (diff < 1000) return;
        impressionTrackedRef.current = true;
        worker.send('recordAdImpression', {
          userId: currentUser.id,
          duration: diff,
          fingerprint,
          adId,
        });
      }
    };
  }

  const { ref, inView } = useInView({
    root: node?.current,
    threshold: 0.5,
  });

  useEffect(() => {
    if (inView) enterViewRef.current = new Date();
    else if (enterViewRef.current) trackImpressionRef.current?.();
  }, [inView]);

  useEffect(() => {
    const handler = trackImpressionRef.current;
    if (!handler) return;
    window.addEventListener('beforeunload', handler);

    return () => {
      handler();
      window.removeEventListener('beforeunload', handler);
    };
  }, []);

  return (
    <div ref={ref} {...props}>
      {children}
    </div>
  );
}

export function DynamicAd() {
  return (
    <AdWrapper width={300} height={250}>
      {({ isMobile }) => {
        const id = isMobile ? 'civitaicom47764' : 'civitaicom47455';
        return (
          <ImpressionTracker adId={id} className="w-full overflow-hidden">
            <div id={id} />
          </ImpressionTracker>
        );
      }}
    </AdWrapper>
  );
}

export function ModelAndImagePageAdUnit() {
  const { adsEnabled } = useAdsContext();

  if (!adsEnabled) return null;

  return (
    <div className="flex justify-center">
      <AdWrapper component="TwCard" className="border p-2 shadow" width={300} height={250}>
        {({ isMobile }) => {
          const id = isMobile ? 'civitaicom47765' : 'civitaicom47763';
          return (
            <ImpressionTracker adId={id} className="w-full overflow-hidden">
              <div id={id} />
            </ImpressionTracker>
          );
        }}
      </AdWrapper>
    </div>
  );
}
