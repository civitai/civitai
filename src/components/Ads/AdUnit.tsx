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

const useStyles = createStyles((theme) => ({
  root: { display: 'flex', flexDirection: 'column', background: 'none' },
}));

export function AdunitOld<TAscendeum extends AscendeumAdUnitType>({
  browsingLevelOverride,
  sfw,
  nsfw,
  children,
  showRemoveAds,
  className,
  ...paperProps
}: {
  browsingLevelOverride?: BrowsingLevel[];
  sfw: AscendeumAdUnit<TAscendeum>;
  nsfw?: ExoclickAdUnit;
  children?: (Ad: JSX.Element) => React.ReactElement;
  showRemoveAds?: boolean;
} & PaperProps) {
  return null;
  // const { classes, cx } = useStyles();
  // const { ref, inView } = useInView({ rootMargin: '200%' });
  // const { isCurrentStack } = useStackingContext();
  // const { adsBlocked, adsEnabled, providers, username } = useAdsContext();
  // const containerWidth = useContainerWidth();

  // // TODO - maybe consider the priority of each nsfw override flag. Which flags have the most priority?
  // const showNsfw = false; // temporary until we come back to ads and nsfw levels
  // const renderTypeMap = { sfw, nsfw };
  // const renderType = !showNsfw ? 'sfw' : 'nsfw';
  // const componentProps = useMemo(() => renderTypeMap[renderType], [renderType]);

  // // TODO - check if this value causes render on each container width change
  // const bidSizes = useMemo(() => {
  //   if (!componentProps) return undefined;

  //   const breakpoints = [...componentProps.breakpoints].reverse();
  //   for (const { minWidth, maxWidth, sizes } of breakpoints) {
  //     const satisfiesMinWidth = minWidth ? containerWidth >= minWidth : true;
  //     const satisfiesMaxWidth = maxWidth ? containerWidth <= maxWidth : true;
  //     if (satisfiesMinWidth && satisfiesMaxWidth) {
  //       const bidSizes = (sizes ? (Array.isArray(sizes) ? sizes : [sizes]) : []) as string[];
  //       const filtered = bidSizes.filter(isDefined);
  //       if (filtered.length) return filtered;
  //     }
  //   }
  // }, [containerWidth, renderType]);

  // if (!bidSizes || !adsEnabled) return null;

  // const canRenderContent = inView && isCurrentStack;
  // const showPlaceholderImage =
  //   adsBlocked || !componentProps || !providers.includes(componentProps.type);
  // const [width, height] = bidSizes[0].split('x').map(Number);

  // const Content = (
  //   <>
  //     <Center mih={height} miw={width}>
  //       {canRenderContent && (
  //         <>
  //           {showPlaceholderImage ? (
  //             <AdPlaceholder size={bidSizes[0]} />
  //           ) : (
  //             <AdContent componentProps={componentProps} bidSizes={bidSizes} />
  //           )}
  //         </>
  //       )}
  //     </Center>
  //     {showRemoveAds && (
  //       // <Text
  //       //   component={NextLink}
  //       //   td="underline"
  //       //   href="/pricing"
  //       //   color="dimmed"
  //       //   size="xs"
  //       //   align="center"
  //       // >
  //       //   Remove ads
  //       // </Text>
  //       <Group position="apart" miw={width}>
  //         <Text
  //           component={NextLink}
  //           td="underline"
  //           href="/pricing"
  //           color="dimmed"
  //           size="xs"
  //           align="center"
  //         >
  //           Remove ads
  //         </Text>

  //         <Text
  //           component={NextLink}
  //           td="underline"
  //           href={`/ad-feedback?Username=${username}`}
  //           color="dimmed"
  //           size="xs"
  //           align="center"
  //         >
  //           Feedback
  //         </Text>
  //       </Group>
  //     )}
  //   </>
  // );

  // return (
  //   <Paper component={Center} ref={ref} className={cx(classes.root, className)} {...paperProps}>
  //     {children ? children(Content) : Content}
  //   </Paper>
  // );
}

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
          ) : (
            <ImpressionTracker className="w-full overflow-hidden">
              {typeof children === 'function' ? children({ isMobile }) : children}
            </ImpressionTracker>
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

function ImpressionTracker({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const currentUser = useCurrentUser();
  const node = useScrollAreaRef();
  const { worker } = useSignalContext();
  const enterViewRef = useRef<Date>();
  const exitViewRef = useRef<Date>();
  const impressionTrackedRef = useRef<boolean>();

  const { ref, inView } = useInView({
    root: node?.current,
    threshold: 0.5,
  });

  useEffect(() => {
    if (inView) {
      enterViewRef.current = new Date();
      console.log(enterViewRef.current);
    } else exitViewRef.current = new Date();
  }, [inView]);

  useEffect(() => {
    function trackImpression() {
      const enterDate = enterViewRef.current;
      const exitDate = exitViewRef.current ?? new Date();
      if (worker && enterDate && currentUser && !impressionTrackedRef.current) {
        const diff = exitDate.getTime() - enterDate.getTime();
        if (diff < 1000) return;
        impressionTrackedRef.current = true;
        worker.send('recordAdImpression', {
          userId: currentUser.id,
          duration: diff,
          deviceId: 'undefined', // TODO
          adId: 'undefined', // TODO
        });
      }
    }

    window.addEventListener('beforeunload', trackImpression);

    return () => {
      trackImpression();
      window.removeEventListener('beforeunload', trackImpression);
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
      {({ isMobile }) =>
        isMobile ? (
          <pgs-ad data-pg-ad-spot="civitaicom47764"></pgs-ad>
        ) : (
          <pgs-ad data-pg-ad-spot="civitaicom47455"></pgs-ad>
        )
      }
    </AdWrapper>
  );
}

export function ModelAndImagePageAdUnit() {
  const { adsEnabled } = useAdsContext();

  if (!adsEnabled) return null;

  return (
    <div className="flex justify-center">
      <AdWrapper component="TwCard" className="border p-2 shadow" width={300} height={250}>
        {({ isMobile }) => (isMobile ? <div id="civitaicom47765" /> : <div id="civitaicom47763" />)}
      </AdWrapper>
    </div>
  );
}

// export function AdUnit

// function AdPlaceholder({ size }: { size: string }) {
//   const { adsBlocked } = useAdsContext();
//   const _size = adSizeImageMap[size as AnyAdSize];
//   if (!_size) return null;
//   const [width, height] = _size.split('x').map(Number);

//   return adsBlocked ? (
//     <NextLink href="/pricing" style={{ display: 'flex' }}>
//       <Image
//         src={`/images/support-us/${width}x${height}.jpg`}
//         alt="Please support civitai and creators by disabling adblock"
//         width={width}
//         height={height}
//       />
//     </NextLink>
//   ) : (
//     <NextLink href="/pricing" style={{ display: 'flex' }}>
//       <Image
//         src={`/images/become-a-member/${width}x${height}.jpg`}
//         alt="Please become a member to support creators today"
//         width={width}
//         height={height}
//       />
//     </NextLink>
//   );
// }

// function AdContent<TAscendeum extends AscendeumAdUnitType>({
//   componentProps,
//   bidSizes,
// }: {
//   componentProps: AscendeumAdUnit<TAscendeum> | ExoclickAdUnit;
//   bidSizes: string[];
// }) {
//   if (!componentProps || !bidSizes) return null;

//   switch (componentProps.type) {
//     case 'ascendeum':
//       return <AscendeumAd adunit={componentProps.adunit} bidSizes={bidSizes} />;
//     case 'exoclick':
//       return <ExoclickAd bidSizes={bidSizes} />;
//   }
// }
