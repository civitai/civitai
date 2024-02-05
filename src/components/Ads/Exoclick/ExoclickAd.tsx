import { exoclickAdunitSizeMap, ExoclickAdSizes } from '~/components/Ads/ads.utils';

// const debouncer = createDebouncer(50);
// const emitter = new EventEmitter<{ serve: undefined }>();
// emitter.on('serve', () =>
//   debouncer(() => {
//     (window.AdProvider = window.AdProvider || []).push({ serve: {} });
//   })
// );
export function ExoclickAd({ bidSizes }: { bidSizes: string[] }) {
  const bidSize = bidSizes[0] as ExoclickAdSizes[number];
  const zoneId = exoclickAdunitSizeMap[bidSize];

  const [width, height] = bidSize.split('x');

  // const hasRunRef = useRef(false);
  // useEffect(() => {
  //   if (!hasRunRef.current) {
  //     hasRunRef.current = true;
  //     emitter.emit('serve', undefined);
  //   }
  // }, []);

  return (
    <iframe
      src={`https://a.magsrv.com/iframe.php?idzone=${zoneId}&size=${bidSize}`}
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
