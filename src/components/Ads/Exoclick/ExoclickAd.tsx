import { useDidUpdate } from '@mantine/hooks';
import { useEffect, useRef } from 'react';
import { createDebouncer } from '~/utils/debouncer';
import { EventEmitter } from '~/utils/eventEmitter';

declare global {
  interface Window {
    AdProvider: any[];
  }
}

// const debouncer = createDebouncer(50);
// const emitter = new EventEmitter<{ serve: undefined }>();
// emitter.on('serve', () =>
//   debouncer(() => {
//     (window.AdProvider = window.AdProvider || []).push({ serve: {} });
//   })
// );

export function ExoclickAd({ zoneId, size }: { zoneId: string; size: string }) {
  // const hasRunRef = useRef(false);
  // useEffect(() => {
  //   if (!hasRunRef.current) {
  //     hasRunRef.current = true;
  //     emitter.emit('serve', undefined);
  //   }
  // }, []);
  const [width, height] = size.split('x');

  return (
    <iframe
      src={`https://a.magsrv.com/iframe.php?idzone=${zoneId}&size=${size}`}
      width={width}
      height={height}
      scrolling="no"
      marginWidth={0}
      marginHeight={0}
      frameBorder={0}
    ></iframe>
  );

  // return (
  //   <div>
  //     <ins className="eas6a97888e2" data-zoneid={zoneId} />
  //   </div>
  // );
}
