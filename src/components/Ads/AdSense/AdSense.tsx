import { Box, BoxProps } from '@mantine/core';
import { useEffect, useRef } from 'react';
import { isProd } from '~/env/other';
import { createDebouncer } from '~/utils/debouncer';
import { EventEmitter } from '~/utils/eventEmitter';

declare global {
  interface Window {
    adsbygoogle: any[];
  }
}

const debouncer = createDebouncer(50);
const emitter = new EventEmitter<{ serve: undefined }>();
emitter.on('serve', () =>
  debouncer(() => {
    (window.adsbygoogle = window.adsbygoogle || []).push({ serve: {} });
  })
);

export function AdSenseAd(props: BoxProps) {
  const hasRunRef = useRef(false);
  useEffect(() => {
    if (!hasRunRef.current) {
      hasRunRef.current = true;
      emitter.emit('serve', undefined);
    }
  }, []);

  return (
    <Box {...props}>
      <ins
        className="adsbygoogle"
        style={{ display: 'block', width: 300, height: 250 }}
        data-ad-client="ca-pub-6320044818993728"
        data-ad-slot="2186801716"
        data-adtest="on"
      ></ins>
    </Box>
  );
}
