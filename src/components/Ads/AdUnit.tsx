import { AdSizes } from '~/components/Ads/ads.utils';
import { Text } from '@mantine/core';
import React from 'react';
import { useAdsContext } from '~/components/Ads/AdsProvider';
import Image from 'next/image';
import { NextLink } from '@mantine/next';
import clsx from 'clsx';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsClient } from '~/providers/IsClientProvider';
import { TwCard } from '~/components/TwCard/TwCard';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';

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
  const isClient = useIsClient();
  const { adsBlocked, adsEnabled, isMember } = useAdsContext();
  const browsingLevel = useBrowsingLevelDebounced();
  const isMobile =
    typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
  // const focused = useIsLevelFocused();

  if (!adsEnabled || !getIsSafeBrowsingLevel(browsingLevel)) return null;

  const Component = component === 'div' ? 'div' : TwCard;

  return (
    <Component
      className={clsx('flex flex-col items-center justify-between', className)}
      style={{ ...style, minHeight: height + 20, minWidth: width }}
      {...props}
    >
      {isClient && adsBlocked !== undefined && (
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
            <div className="w-full overflow-hidden">
              {typeof children === 'function' ? children({ isMobile }) : children}
            </div>
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

export function DynamicAd() {
  return (
    <AdWrapper width={300} height={250}>
      {({ isMobile }) => {
        const id = isMobile ? 'civitaicom47764' : 'civitaicom47455';
        return <div id={id} />;
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
          return <div id={id} />;
        }}
      </AdWrapper>
    </div>
  );
}

// export function LeaderboardAd_A() {
//   return (
//     <AdWrapper>
//       {({ isMobile }) =>
//         isMobile ? <div id="civitaicom47760"></div> : <div id="civitaicom47456"></div>
//       }
//     </AdWrapper>
//   );
// }
