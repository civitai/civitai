import { Paper } from '@mantine/core';
import { useEffect, useRef } from 'react';
import { useAscendeumAdsContext } from '~/components/AscendeumAds/AscendeumAdsProvider';
import { ascAdManager } from '~/components/AscendeumAds/client';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { BrowsingMode } from '~/server/common/enums';

export function AscendeumAd({
  adunit,
  height,
  width,
}: {
  adunit: string;
  width: number;
  height: number;
}) {
  const { ready } = useAscendeumAdsContext();
  return (
    <Paper h={height} w={width} withBorder>
      {ready && <AscendeumAdContent adunit={adunit} />}
    </Paper>
  );
}

function AscendeumAdContent({ adunit }: { adunit: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ascAdManager.processAdsOnPage();
  }, [adunit]);

  useEffect(() => {
    return () => {
      // extra malarkey to handle strict mode side effects
      if (!ref.current) ascAdManager.destroyAdunits([adunit]);
    };
  }, []);

  return <div ref={ref} data-aaad="true" data-aa-adunit={adunit} />;
}
