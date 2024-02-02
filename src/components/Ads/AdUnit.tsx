import {
  AnyAdSize,
  AscendeumAdUnit,
  AscendeumAdUnitType,
  ExoclickAdUnit,
  adSizeImageMap,
} from '~/components/Ads/ads.utils';
import { Box, BoxProps, Center, Group, Paper, PaperProps, Text, createStyles } from '@mantine/core';
import React, { useMemo } from 'react';
import { useAdsContext } from '~/components/Ads/AdsProvider';
import { useContainerWidth } from '~/components/ContainerProvider/ContainerProvider';
import { useInView } from '~/hooks/useInView';
import Image from 'next/image';
import { useStackingContext } from '~/components/Dialog/dialogStore';
import { NextLink } from '@mantine/next';
import { ExoclickAd } from '~/components/Ads/Exoclick/ExoclickAd2';
import { useHiddenPreferencesContext } from '~/providers/HiddenPreferencesProvider';
import { BrowsingMode } from '~/server/common/enums';
import { AscendeumAd } from '~/components/Ads/AscendeumAds/AscendeumAd2';
import { isDefined } from '~/utils/type-guards';

export function Adunit<TAscendeum extends AscendeumAdUnitType>({
  browsingModeOverride,
  sfw,
  nsfw,
  children,
  showRemoveAds,
  className,
  ...paperProps
}: {
  browsingModeOverride?: BrowsingMode;
  sfw: AscendeumAdUnit<TAscendeum>;
  nsfw?: ExoclickAdUnit;
  children?: (Ad: JSX.Element) => React.ReactElement;
  showRemoveAds?: boolean;
} & PaperProps) {
  const { classes, cx } = useStyles();
  const [ref, inView] = useInView({ rootMargin: '200%' });
  const { isCurrentStack } = useStackingContext();
  const { browsingMode } = useHiddenPreferencesContext();
  const { adsBlocked, nsfwOverride, adsEnabled, providers, cookieConsent } = useAdsContext();
  const containerWidth = useContainerWidth();

  const showNsfw = nsfwOverride ?? (browsingModeOverride ?? browsingMode) !== BrowsingMode.SFW;
  const renderTypeMap = { sfw, nsfw };
  const renderType = !showNsfw ? 'sfw' : 'nsfw';
  const componentProps = useMemo(() => renderTypeMap[renderType], [renderType]);

  // TODO - check if this value causes render on each container width change
  const bidSizes = useMemo(() => {
    if (!componentProps) return undefined;

    const breakpoints = [...componentProps.breakpoints].reverse();
    for (const { minWidth, maxWidth, sizes } of breakpoints) {
      const satisfiesMinWidth = minWidth ? containerWidth >= minWidth : true;
      const satisfiesMaxWidth = maxWidth ? containerWidth <= maxWidth : true;
      if (satisfiesMinWidth && satisfiesMaxWidth) {
        const bidSizes = (Array.isArray(sizes) ? sizes : [sizes]).filter(isDefined) as string[];
        if (bidSizes.length) return bidSizes;
      }
    }
  }, [containerWidth, renderType]);

  if (!bidSizes || !adsEnabled) return null;

  const canRenderContent = inView && isCurrentStack;
  const showPlaceholderImage =
    adsBlocked || !cookieConsent || !componentProps || !providers.includes(componentProps.type);
  const [width, height] = bidSizes[0].split('x').map(Number);

  const Content = (
    <>
      <Center mih={height} miw={width}>
        {canRenderContent && (
          <>
            {showPlaceholderImage ? (
              <AdPlaceholder size={bidSizes[0]} />
            ) : (
              <AdContent componentProps={componentProps} bidSizes={bidSizes} />
            )}
          </>
        )}
      </Center>
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
    </>
  );

  return (
    <Paper component={Center} ref={ref} className={cx(classes.root, className)} {...paperProps}>
      {children ? children(Content) : Content}
    </Paper>
  );
}

const useStyles = createStyles((theme) => ({
  root: { display: 'flex', flexDirection: 'column', background: 'none' },
}));

function PlaceholderImage({ height, width }: { height: number; width: number }) {
  const { adsBlocked } = useAdsContext();

  return adsBlocked ? (
    <NextLink href="/pricing" style={{ display: 'flex' }}>
      <Image
        src={`/images/support-us/${width}x${height}.jpg`}
        alt="Please support civitai and creators by disabling adblock"
        width={width}
        height={height}
      />
    </NextLink>
  ) : (
    <NextLink href="/pricing" style={{ display: 'flex' }}>
      <Image
        src={`/images/become-a-member/${width}x${height}.jpg`}
        alt="Please become a member to support creators today"
        width={width}
        height={height}
      />
    </NextLink>
  );
}

function AdPlaceholder({ size }: { size: string }) {
  const { adsBlocked } = useAdsContext();
  const _size = adSizeImageMap[size as AnyAdSize];
  if (!_size) return null;
  const [width, height] = size.split('x').map(Number);
  const [imageWidth, imageHeight] = _size.split('x').map(Number);
  const dir = adsBlocked ? '/images/support-us' : '/images/become-a-member';

  return (
    <Paper
      w={imageWidth}
      h={imageHeight}
      withBorder
      style={{ backgroundImage: `url(${dir}/${imageWidth}x${imageHeight}.jpg)` }}
      sx={{
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'center',
      }}
    ></Paper>
  );
}

function AdContent<TAscendeum extends AscendeumAdUnitType>({
  componentProps,
  bidSizes,
}: {
  componentProps: AscendeumAdUnit<TAscendeum> | ExoclickAdUnit;
  bidSizes: string[];
}) {
  if (!componentProps || !bidSizes) return null;

  switch (componentProps.type) {
    case 'ascendeum':
      return <AscendeumAd adunit={componentProps.adunit} bidSizes={bidSizes} />;
    case 'exoclick':
      return <ExoclickAd bidSizes={bidSizes} />;
  }
}
