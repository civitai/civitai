import type { AdUnitDetail, AdUnitKey } from '~/components/Ads/Old/ads.utils';
import { getAdUnitDetails } from '~/components/Ads/Old/ads.utils';
import { Text } from '@mantine/core';
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAdsContext } from '~/components/Ads/AdsProvider';
import Image from 'next/image';
import clsx from 'clsx';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsClient } from '~/providers/IsClientProvider';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { useIsomorphicLayoutEffect } from '~/hooks/useIsomorphicLayoutEffect';
import { useInView } from 'react-intersection-observer';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import { useDebouncer } from '~/utils/debouncer';
import { isMobileDevice } from '~/hooks/useIsMobile';
import { NextLink as Link } from '~/components/NextLink/NextLink';

type AdWrapperProps = Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> & {
  width?: number;
  height?: number;
  children: React.ReactNode | ((args: { isMobile: boolean }) => React.ReactNode);
};

const AdWrapper = ({ children, className, width, height, style, ...props }: AdWrapperProps) => {
  const node = useScrollAreaRef();
  const currentUser = useCurrentUser();
  const isClient = useIsClient();
  const [visible, setVisible] = useState(false);
  const { adsBlocked, isMember } = useAdsContext();
  const isMobile = isMobileDevice();
  const { withFeedback } = useAdUnitContext();
  const { item } = useAdUnitContext();
  // const focused = useIsLevelFocused();

  const { ref, inView } = useInView({ root: node?.current, rootMargin: '75% 0px' });
  useEffect(() => {
    if (inView && !visible) {
      setVisible(true);
    }
  }, [inView]);

  return (
    <div
      ref={ref}
      className={clsx('flex flex-col items-center justify-between', className)}
      style={{
        ...style,
        minHeight: height ? height + (withFeedback ? 20 : 0) : undefined,
        // don't change this logic without consulting Briant
        // width - 1 allows the parent AdUnit to remove this content when its parent width is too small
        minWidth: width ? width - 1 : undefined,
      }}
      {...props}
    >
      {isClient && adsBlocked !== undefined && height && width && (
        <>
          {adsBlocked ? (
            <Link href="/pricing" className="flex">
              <Image
                src={`/images/support-us/${width}x${height}.jpg`}
                alt="Please support civitai and creators by disabling adblock"
                width={width}
                height={height}
              />
            </Link>
          ) : (
            <div className="w-full overflow-hidden" key={item.id}>
              {visible && (typeof children === 'function' ? children({ isMobile }) : children)}
            </div>
          )}

          {withFeedback && (
            <>
              <div className="flex w-full justify-between">
                {!isMember ? (
                  <Text
                    component={Link}
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
                    component={Link}
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
        </>
      )}
    </div>
  );
};

type ContextState = {
  item: AdUnitDetail;
  withFeedback?: boolean;
};

const AdUnitContext = createContext<ContextState | null>(null);
function useAdUnitContext() {
  const context = useContext(AdUnitContext);
  if (!context) throw new Error('missing AdUnitContext');
  return context;
}

function AdUnitContent() {
  const { item } = useAdUnitContext();

  return (
    <AdWrapper width={item.width} height={item.height}>
      {item && (
        <>
          {item.type === 'dynamic' ? (
            <pgs-ad data-pg-ad-spot={item.id}></pgs-ad>
          ) : (
            <div id={item.id}></div>
          )}
        </>
      )}
    </AdWrapper>
  );
}

export function AdUnit({
  keys,
  withFeedback,
  children,
  className,
  style,
  justify,
  browsingLevel: browsingLevelOverride,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  keys: AdUnitKey[];
  withFeedback?: boolean;
  justify?: 'start' | 'end' | 'center';
  browsingLevel?: number;
}) {
  const { adsEnabled } = useAdsContext();
  const ref = useRef<HTMLDivElement | null>(null);
  const details = getAdUnitDetails(keys);
  const [width, setWidth] = useState<number>();
  const item = useMemo(
    () =>
      width
        ? details.find((x) => {
            // don't change this logic without consulting Briant
            return x.width <= width;
          })
        : undefined,
    [keys.join(','), width]
  );
  const debouncer = useDebouncer(300);
  const prevWidthRef = useRef<number | null>(null);
  const browsingLevel = useBrowsingLevelDebounced();
  const nsfw = !getIsSafeBrowsingLevel(browsingLevelOverride ?? browsingLevel);

  useIsomorphicLayoutEffect(() => {
    const node = ref.current?.parentElement ?? ref.current;
    if (ref.current && node) {
      setWidth(getClientWidth(node));
      const resizeObserver = new ResizeObserver((entries) => {
        const clientWidth = entries[0].contentBoxSize[0].inlineSize;
        const widthChanged = prevWidthRef.current !== clientWidth;
        if (!widthChanged) return;

        prevWidthRef.current = clientWidth;
        debouncer(() => setWidth(clientWidth));
      });

      resizeObserver.observe(node);
      return () => {
        resizeObserver.disconnect();
      };
    }
  }, [nsfw]);

  if (!adsEnabled || nsfw) return null;

  return (
    <div
      className={clsx(
        'flex w-full max-w-full',
        {
          ['justify-start']: justify === 'start',
          ['justify-center']: justify === 'center',
          ['justify-end']: justify === 'end',
        },
        className
      )}
      ref={ref}
      style={!item ? { display: 'none', ...style } : style}
      {...props}
    >
      {item && (
        <AdUnitContext.Provider value={{ item, withFeedback }}>
          {children ?? <AdUnitContent />}
        </AdUnitContext.Provider>
      )}
    </div>
  );
}

AdUnit.Content = AdUnitContent;

function getClientWidth(node: HTMLElement) {
  if (node.style.display !== 'none') return node.clientWidth;
  else {
    node.style.removeProperty('display');
    const clientWidth = node.clientWidth;
    node.style.setProperty('display', 'none');
    return clientWidth;
  }
}
