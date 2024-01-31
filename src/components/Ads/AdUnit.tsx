import { AscendeumAdUnit, AscendeumAdUnitType, ExoclickAdUnit } from '~/components/Ads/ads.utils';
import { Box, BoxProps, Center, Group, Paper, Stack, Text } from '@mantine/core';
import { useDidUpdate } from '@mantine/hooks';
import React, { useEffect, useMemo, useRef } from 'react';
import { useAdsContext } from '~/components/Ads/AdsProvider';
import { ascAdManager } from '~/components/Ads/AscendeumAds/client';
import { useContainerWidth } from '~/components/ContainerProvider/ContainerProvider';
import { useInView } from '~/hooks/useInView';
import Image from 'next/image';
import { useStackingContext } from '~/components/Dialog/dialogStore';
import { v4 as uuidv4 } from 'uuid';
import { NextLink } from '@mantine/next';
import { ExoclickAd } from '~/components/Ads/Exoclick/ExoclickAd';
import { useHiddenPreferencesContext } from '~/providers/HiddenPreferencesProvider';
import { BrowsingMode } from '~/server/common/enums';

export function AdUnit<TAscendeum extends AscendeumAdUnitType>({
  browsingMode: browsingModeOverride,
  sfw,
  nsfw,
  children,
}: {
  browsingMode?: BrowsingMode;
  sfw: AscendeumAdUnit<TAscendeum>;
  nsfw?: ExoclickAdUnit;
  children?: (Ad: JSX.Element) => React.ReactElement;
}) {
  const [ref, inView] = useInView({ rootMargin: '200%' });
  const { isCurrentStack } = useStackingContext();
  const { browsingMode } = useHiddenPreferencesContext();
  const {
    adsBlocked,
    nsfwOverride,
    adsEnabled,
    username,
    ascendeumReady,
    exoclickReady,
    cmpDeclined,
    available,
  } = useAdsContext();
  const containerWidth = useContainerWidth();

  const showNsfw = nsfwOverride ?? (browsingModeOverride ?? browsingMode) !== BrowsingMode.SFW;

  return <></>;
}

// function Test() {
//   return (
//     <>
//       <AdUnit
//         sfw={{
//           type: 'ascendeum',
//           adunit: 'Leaderboard_A',
//           breakpoints: [{ minWidth: 300, sizes: ['728x90'] }],
//         }}
//         nsfw={{
//           type: 'exoclick',
//           breakpoints: [{ minWidth: 300, sizes: ['728x90'] }],
//         }}
//       />
//     </>
//   );
// }
