import { Center, Paper, Text } from '@mantine/core';
import { useEffect, useRef } from 'react';
import { useAscendeumAdsContext } from '~/components/AscendeumAds/AscendeumAdsProvider';
import { ascAdManager } from '~/components/AscendeumAds/client';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { BrowsingMode } from '~/server/common/enums';

type AdContentProps = { adunit: string; refreshInterval?: number };
type AdProps = AdContentProps & {
  width: number;
  height: number;
};

export function AscendeumAd({ height, width, ...adContentProps }: AdProps) {
  const { ready, adsBlocked, canView } = useAscendeumAdsContext();
  return (
    <Paper component={Center} h={height} w={width} withBorder>
      {adsBlocked ? (
        <Text align="center" p="md">
          Please consider turning off ad block to support us
        </Text>
      ) : (
        ready && canView && <AscendeumAdContent {...adContentProps} />
      )}
    </Paper>
  );
}

function AscendeumAdContent({ adunit, refreshInterval }: AdContentProps) {
  const ref = useRef<HTMLDivElement>(null);

  // do we want each ad to have their own refreshInterval
  // should every add have a refresh interval?
  useEffect(() => {
    let interval: NodeJS.Timer | undefined;
    ascAdManager.processAdsOnPage();
    if (refreshInterval) {
      interval = setInterval(() => {
        ascAdManager.refreshAdunits([adunit]);
      }, refreshInterval * 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [adunit, refreshInterval]);

  useEffect(() => {
    return () => {
      // extra malarkey to handle strict mode side effects
      if (!ref.current) ascAdManager.destroyAdunits([adunit]);
    };
  }, []);

  return <div ref={ref} data-aaad="true" data-aa-adunit={adunit} />;
}
