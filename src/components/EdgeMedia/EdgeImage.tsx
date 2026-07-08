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
  /**
   * Mark this image as the LCP / above-the-fold candidate. When set, emits
   * `loading="eager"` + `fetchpriority="high"` so the browser fetches it ahead
   * of the many sibling card images it would otherwise contend with. Off (the
   * default) is byte-identical to the previous render (no attributes emitted).
   * Reserve for the first N cards in a viewport — priority on everything is
   * priority on nothing.
   */
  priority?: boolean;
};

// `@types/react@18.0.14` predates the `fetchPriority` img attribute (added
// upstream in the 18.3 typings; the deployed react-dom is 18.3.1). react-dom
// 18.3.1 has no `fetchPriority` in its known-attribute map either, so we emit
// the canonical lowercase HTML attribute `fetchpriority` — React passes
// lowercase custom attributes through to the DOM verbatim and browsers read the
// attribute case-insensitively. The single controlled cast lives here so the
// rest of the chain threads a clean typed `priority: boolean`.
const priorityImgAttrs = {
  loading: 'eager',
  fetchpriority: 'high',
} as unknown as React.ImgHTMLAttributes<HTMLImageElement>;

export const EdgeImage = forwardRef<HTMLImageElement, EdgeImageProps>(
  (
    { className, fadeIn, src, options, style, onLoad, onError, imageId, priority, ...props },
    forwardedRef
  ) => {
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
        {...(priority ? priorityImgAttrs : undefined)}
      />
    );
  }
);

EdgeImage.displayName = 'EdgeImage';
