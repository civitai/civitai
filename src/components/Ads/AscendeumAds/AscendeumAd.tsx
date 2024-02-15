import { useDidUpdate } from '@mantine/hooks';
import React, { useEffect, useRef } from 'react';
import { ascAdManager } from '~/components/Ads/AscendeumAds/client';
import { v4 as uuidv4 } from 'uuid';
import { createDebouncer } from '~/utils/debouncer';
import { EventEmitter } from '~/utils/eventEmitter';

// const debouncer = createDebouncer(50);
// const emitter = new EventEmitter<{ refresh: undefined }>();
// emitter.on('refresh', () => debouncer(() => ascAdManager.refresh()));

export function AscendeumAd({ adunit, bidSizes }: { adunit: string; bidSizes: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const _adunit = `/21718562853/CivitAI/${adunit}`;
  const _bidSizes = `[${bidSizes.map((sizes) => `[${sizes.replace('x', ',')}]`)}]`;
  const idRef = useRef(uuidv4());

  // do we want each ad to have their own refreshInterval
  // should every add have a refresh interval?
  useEffect(() => {
    ascAdManager.processAdsOnPage([_adunit]);
  }, [_adunit]);

  useDidUpdate(() => {
    setTimeout(() => {
      ascAdManager.refreshIds([idRef.current]);
    }, 100);
  }, [_bidSizes]);

  useEffect(() => {
    return () => {
      // extra malarkey to handle strict mode side effects
      if (!ref.current) {
        ascAdManager.destroyIds([idRef.current]);
      }
    };
  }, []);

  return (
    <div
      id={idRef.current}
      ref={ref}
      data-aaad="true"
      data-aa-adunit={_adunit}
      data-aa-sizes={_bidSizes}
      style={{ overflow: 'hidden' }}
    />
  );
}
