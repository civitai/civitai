import { exoclickAdunitSizeMap, ExoclickAdSizes } from '~/components/Ads/ads.utils';

export function ExoclickAd({ bidSizes }: { bidSizes: string[] }) {
  const bidSize = bidSizes[0] as ExoclickAdSizes[number];
  const zoneId = exoclickAdunitSizeMap[bidSize];

  const [width, height] = bidSize.split('x');

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
}
