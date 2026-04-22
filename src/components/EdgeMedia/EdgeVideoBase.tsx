import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { EdgeUrlProps } from '~/client-utils/cf-images-utils';
import { useEdgeUrl } from '~/client-utils/cf-images-utils';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';

type VideoProps = Omit<
  React.DetailedHTMLProps<React.VideoHTMLAttributes<HTMLVideoElement>, HTMLVideoElement>,
  'height' | 'width' | 'src' | 'ref'
>;

export type EdgeVideoBaseProps = VideoProps & {
  src: string;
  thumbnailUrl?: string;
  fadeIn?: boolean;
  threshold?: number | null;
  options?: Omit<EdgeUrlProps, 'src'>;
};

export const EdgeVideoBase = forwardRef<HTMLVideoElement, EdgeVideoBaseProps>(
  ({ src, options, thumbnailUrl, threshold = 0.25, autoPlay, ...props }, forwardedRef) => {
    const ref = useRef<HTMLVideoElement>(null);
    const node = useScrollAreaRef();
    const [canPlay, setCanPlay] = useState(false);

    useImperativeHandle(forwardedRef, () => ref.current as HTMLVideoElement);

    // Never pass the HTML autoPlay attribute to <video> — the browser would
    // start playback before the observer settles, so off-screen mounts (e.g.
    // rows in the virtualized overscan buffer) would briefly play. Instead,
    // the observer drives a `canPlay` state and the effect below issues
    // play()/pause() explicitly.
    useEffect(() => {
      const videoElem = ref.current;
      if (!videoElem || threshold === null) return;
      const observer = new IntersectionObserver(
        ([{ intersectionRatio }]) => {
          setCanPlay(intersectionRatio >= threshold);
        },
        { root: node?.current, threshold: [threshold, 1 - threshold] }
      );
      observer.observe(videoElem);
      return () => {
        observer.unobserve(videoElem);
        observer.disconnect();
      };
    }, [threshold]);

    useEffect(() => {
      const videoElem = ref.current;
      if (!videoElem) return;
      const shouldPlay = !!autoPlay && (threshold === null || canPlay);
      if (shouldPlay) {
        videoElem.play().catch(() => {
          // Autoplay blocked (e.g. user-interaction required); stay paused.
        });
      } else {
        videoElem.pause();
      }
    }, [canPlay, autoPlay, threshold]);

    const { url: videoUrl } = useEdgeUrl(src, { ...options, anim: true });
    const { url: coverUrl } = useEdgeUrl(thumbnailUrl ?? src, {
      ...options,
      anim: false,
      original: false,
    });

    return (
      <video ref={ref} poster={coverUrl} loop playsInline disablePictureInPicture {...props}>
        <source src={videoUrl.replace('.mp4', '.webm')} type="video/webm" />
        <source src={videoUrl} type="video/mp4" />
      </video>
    );
  }
);

EdgeVideoBase.displayName = 'EdgeVideoBase';
