import { forwardRef } from 'react';
import { createStyles } from '@mantine/core';

type Props = {
  index: number;
  image?: CustomFile;
  children?: React.ReactNode;
} & React.ComponentPropsWithoutRef<'div'>;

export const ImagePreview = forwardRef<HTMLDivElement, Props>(
  ({ index, image, children, ...props }, ref) => {
    const { classes, cx } = useStyles({ index, url: image?.url });
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
  (theme, { index, url, faded }: { index: number; url?: string; faded?: boolean }) => ({
    root: {
      position: 'relative',
      opacity: faded ? '0.2' : '1',
      transformOrigin: '0 0',
      height: index === 0 ? 410 : 200,
      gridRowStart: index === 0 ? 'span 2' : undefined,
      gridColumnStart: index === 0 ? 'span 2' : undefined,
      backgroundImage: `url("${url}")`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundColor: 'grey',
    },
  })
);
