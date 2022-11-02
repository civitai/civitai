import { forwardRef } from 'react';
import { createStyles } from '@mantine/core';

type Props = {
  index: number;
  image?: CustomFile;
  children?: React.ReactNode;
  isPrimary?: boolean;
} & React.ComponentPropsWithoutRef<'div'>;

export const ImagePreview = forwardRef<HTMLDivElement, Props>(
  ({ index, image, children, isPrimary, ...props }, ref) => {
    const { classes, cx } = useStyles({ index, url: image?.url, isPrimary });
    if (!image) return null;
    return (
      <div ref={ref} className={classes.root} {...props}>
        {children}
      </div>
    );
  }
);
ImagePreview.displayName = 'ImagePreview';

const useStyles = createStyles(
  (
    theme,
    {
      index,
      url,
      faded,
      isPrimary,
    }: { index: number; url?: string; faded?: boolean; isPrimary?: boolean }
  ) => ({
    root: {
      position: 'relative',
      opacity: faded ? '0.2' : '1',
      transformOrigin: '0 0',
      height: isPrimary ? 410 : 200,
      gridRowStart: isPrimary ? 'span 2' : undefined,
      gridColumnStart: isPrimary ? 'span 2' : undefined,
      backgroundImage: `url("${url}")`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundColor: 'grey',
    },
  })
);
