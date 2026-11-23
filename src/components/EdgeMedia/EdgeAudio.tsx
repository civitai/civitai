import { forwardRef } from 'react';
import type { EdgeUrlProps } from '~/client-utils/cf-images-utils';
import { useEdgeUrl } from '~/client-utils/cf-images-utils';
import { claimPlayback } from '~/components/Audio/exclusive-playback';

export type EdgeAudioProps = Omit<
  React.DetailedHTMLProps<React.AudioHTMLAttributes<HTMLAudioElement>, HTMLAudioElement>,
  'src' | 'ref'
> & {
  src: string;
  options?: Omit<EdgeUrlProps, 'src'>;
};

/**
 * Plays the stored audio file as-is: no transcoding and no image transforms. It takes part in
 * "one sound at a time" (`claimPlayback`) whatever the caller passes as `onPlay`.
 */
export const EdgeAudio = forwardRef<HTMLAudioElement, EdgeAudioProps>(
  ({ src, options, controls = true, onPlay, ...props }, ref) => {
    const { url } = useEdgeUrl(src, { ...options, type: 'audio' });
    return (
      <audio
        ref={ref}
        src={url}
        controls={controls}
        preload="metadata"
        {...props}
        onPlay={(e) => {
          // `play` arrives a task late: a play another player already stopped claims nothing.
          if (!e.currentTarget.paused) claimPlayback(e.currentTarget);
          onPlay?.(e);
        }}
      />
    );
  }
);
EdgeAudio.displayName = 'EdgeAudio';
