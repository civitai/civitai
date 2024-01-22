import { Box, BoxProps, createStyles } from '@mantine/core';
import { useEffect, useRef } from 'react';
import { adsterraSizes } from '~/components/Ads/ads.utils';

type Props = {
  size: AdSize;
};

export function AdsterraAd(props: BoxProps) {
  const ref = useRef<HTMLDivElement>(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    const conf = document.createElement('script');
    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.src = '//www.topcreativeformat.com/cc4a2e648e7b1e739697da2e01bd806c/invoke.js';
    conf.innerHTML = `
    atOptions = {
      'key' : 'cc4a2e648e7b1e739697da2e01bd806c',
      'format' : 'iframe',
      'height' : 250,
      'width' : 300,
      'params' : {}
    };
    `;
    ref.current?.append(conf);
    ref.current?.append(script);
  }, []);

  return <Box ref={ref} {...props} />;
}

const useStyles = createStyles((theme) => ({}));

type AdSize = (typeof adsterraSizes)[number];
