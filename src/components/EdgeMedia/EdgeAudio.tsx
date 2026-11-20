import { forwardRef } from 'react';
import type { EdgeUrlProps } from '~/client-utils/cf-images-utils';
import { useEdgeUrl } from '~/client-utils/cf-images-utils';

export type EdgeAudioProps = Omit<
  React.DetailedHTMLProps<React.AudioHTMLAttributes<HTMLAudioElement>, HTMLAudioElement>,
  'src' | 'ref'
> & {
  src: string;
  options?: Omit<EdgeUrlProps, 'src'>;
};

/** Plays the stored audio file as-is: no transcoding and no image transforms. */
export const EdgeAudio = forwardRef<HTMLAudioElement, EdgeAudioProps>(
  ({ src, options, controls = true, ...props }, ref) => {
    const { url } = useEdgeUrl(src, { ...options, type: 'audio' });
    return <audio ref={ref} src={url} controls={controls} preload="metadata" {...props} />;
  }
);
EdgeAudio.displayName = 'EdgeAudio';
