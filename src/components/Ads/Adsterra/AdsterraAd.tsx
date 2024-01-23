import { Box, BoxProps, createStyles } from '@mantine/core';
import { useEffect, useRef } from 'react';
import { adsterraAdSizeIdMap, adsterraSizes } from '~/components/Ads/ads.utils';

type Props = {
  size: AdSize;
} & BoxProps;

export function AdsterraAd({ size, ...props }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    const id = adsterraAdSizeIdMap[size];
    if (loadedRef.current) return;
    loadedRef.current = true;
    const [width, height] = size.split('x');
    const conf = document.createElement('script');
    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.src = `//www.topcreativeformat.com/${id}/invoke.js`;
    conf.innerHTML = `
    atOptions = {
      'key' : '${id}',
      'format' : 'iframe',
      'height' : ${width},
      'width' : ${height},
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
