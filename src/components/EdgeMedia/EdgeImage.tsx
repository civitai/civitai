import type { SyntheticEvent } from 'react';
import { forwardRef, useCallback, useImperativeHandle, useRef } from 'react';
import styles from './EdgeImage.module.scss';
import clsx from 'clsx';
import type { EdgeUrlProps } from '~/client-utils/cf-images-utils';
import { useEdgeUrl } from '~/client-utils/cf-images-utils';

export type EdgeImageProps = React.HTMLAttributes<HTMLImageElement> & {
  src: string;
  fadeIn?: boolean;
  options: Omit<EdgeUrlProps, 'src'>;
  /** Database image ID — included in drag data so drop targets can look up metadata server-side */
  imageId?: number;
};

export const EdgeImage = forwardRef<HTMLImageElement, EdgeImageProps>(
  ({ className, fadeIn, src, options, style, onLoad, onError, imageId, ...props }, forwardedRef) => {
    // const ref = useRef<HTMLImageElement>(null);
    // TODO - determine how we can animate cosmetics
    const { anim, ...rest } = options ?? {};
    const { url } = useEdgeUrl(src, anim !== false ? rest : { ...rest, anim: false });

    // useImperativeHandle(forwardedRef, () => ref.current as HTMLImageElement);

    const handleLoad = useCallback(
      (e: SyntheticEvent<HTMLImageElement, Event>) => {
        if (fadeIn) e.currentTarget.style.opacity = '1';
        onLoad?.(e);
      },
      [fadeIn]
    );

    const handleError = useCallback((e: SyntheticEvent<HTMLImageElement, Event>) => {
      e.currentTarget.classList.add(styles.loadError);
      onError?.(e);
    }, []);

    return (
      // eslint-disable-next-line jsx-a11y/alt-text, @next/next/no-img-element
      <img
        ref={forwardedRef}
        className={clsx(styles.image, { [styles.fadeIn]: fadeIn }, className)}
        onLoad={handleLoad}
        onError={handleError}
        src={url}
        style={{ maxWidth: options?.width ? options.width : undefined, ...style }}
        onDragStart={(e) => {
          e.dataTransfer.setData('text/uri-list', url);
          if (imageId) {
            e.dataTransfer.setData('application/x-civitai-media-id', String(imageId));
            e.dataTransfer.setData('application/x-civitai-media-type', 'image');
          }
        }}
        {...props}
      />
    );
  }
);

EdgeImage.displayName = 'EdgeImage';
