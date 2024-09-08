import { AdUnitDetail, AdUnitKey, getAdUnitDetails } from '~/components/Ads/ads.utils';
import { Text } from '@mantine/core';
import React, {
  MutableRefObject,
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useAdsContext } from '~/components/Ads/AdsProvider';
import Image from 'next/image';
import { NextLink } from '@mantine/next';
import clsx from 'clsx';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsClient } from '~/providers/IsClientProvider';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { useIsomorphicLayoutEffect } from '~/hooks/useIsomorphicLayoutEffect';
import { useInView } from 'react-intersection-observer';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';

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
  const { adsBlocked, adsEnabled, isMember } = useAdsContext();
  const browsingLevel = useBrowsingLevelDebounced();
  const isMobile =
    typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
  const { withFeedback } = useAdUnitContext();
  // const focused = useIsLevelFocused();

  const { ref, inView } = useInView({ root: node?.current, rootMargin: '75% 0px' });
  useEffect(() => {
    if (inView && !visible) {
      setVisible(true);
    }
  }, [inView]);

  if (!adsEnabled || !getIsSafeBrowsingLevel(browsingLevel)) return null;

  return (
    <div
      ref={ref}
      className={clsx('flex flex-col items-center justify-between', className)}
      style={{
        ...style,
        minHeight: height ? height + (withFeedback ? 20 : 0) : undefined,
        minWidth: width,
      }}
      {...props}
    >
      {isClient && adsBlocked !== undefined && height && width && (
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
              {visible && (typeof children === 'function' ? children({ isMobile }) : children)}
            </div>
          )}

          {withFeedback && (
            <>
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
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { keys: AdUnitKey[]; withFeedback?: boolean }) {
  const { adsEnabled } = useAdsContext();
  const ref = useRef<HTMLDivElement | null>(null);
  const details = getAdUnitDetails(keys);
  const [width, setWidth] = useState<number>();
  const item = width ? details.find((x) => x.width <= width) : undefined;

  useIsomorphicLayoutEffect(() => {
    const node = ref.current;
    if (node) {
      let clientWidth = node.clientWidth;
      if (node.style.display === 'none') {
        node.style.removeProperty('display');
        clientWidth = node.clientWidth;
        node.style.setProperty('display', 'none');
      }
      setWidth(clientWidth);
      const observer = new MutationObserver((records) => {
        const elem = records[0];
        if (!elem) return;
        setWidth((elem.target as HTMLDivElement).parentElement?.clientWidth);
      });
      observer.observe(node, { attributes: true, attributeFilter: ['clientWidth'] });
      return () => observer.disconnect();
    }
  }, []);

  if (!adsEnabled) return null;

  return (
    <div
      className={clsx('flex w-full', className)}
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
