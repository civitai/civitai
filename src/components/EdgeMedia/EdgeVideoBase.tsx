import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
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
  ({ src, options, thumbnailUrl, threshold = 0.25, ...props }, forwardedRef) => {
    const ref = useRef<HTMLVideoElement>(null);
    const node = useScrollAreaRef();
    const observerRef = useRef<IntersectionObserver>();

    useImperativeHandle(forwardedRef, () => ref.current as HTMLVideoElement);

    useEffect(() => {
      const videoElem = ref.current;
      if (!videoElem || threshold === null) return;
      if (!observerRef.current) {
        observerRef.current = new IntersectionObserver(
          ([{ isIntersecting, intersectionRatio, target }]) => {
            const elem = target as HTMLVideoElement;
            if (isIntersecting && intersectionRatio >= threshold) {
              elem.play();
            } else if (!isIntersecting || (isIntersecting && intersectionRatio < threshold)) {
              elem.pause();
            }
          },
          { root: node?.current, threshold: [threshold, 1 - threshold] }
        );
      }
      observerRef.current.observe(videoElem);
      return () => {
        observerRef.current?.unobserve(videoElem);
        observerRef.current?.disconnect();
      };
    }, [threshold]);

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
