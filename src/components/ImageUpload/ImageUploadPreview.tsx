import { forwardRef } from 'react';
import { createStyles } from '@mantine/core';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';

type Props = {
  image?: CustomFile;
  children?: React.ReactNode;
  isPrimary?: boolean;
} & React.ComponentPropsWithoutRef<'div'>;

export const ImageUploadPreview = forwardRef<HTMLDivElement, Props>(
  ({ image, children, isPrimary, ...props }, ref) => {
    const url = image?.url.startsWith('http') ? `${image.url}/preview` : image?.url;
    const { classes } = useStyles({ url, isPrimary });
    const { classes: imageClasses } = useImageStyles();
    if (!image) return null;
    return (
      <div ref={ref} className={classes.root} {...props}>
        <EdgeImage className={imageClasses.root} src={image?.url} height={isPrimary ? 410 : 200} />
        {children}
      </div>
    );
  }
);
ImageUploadPreview.displayName = 'ImagePreview';

const useStyles = createStyles(
  (
    theme,
    {
      // index,
      url,
      faded,
      isPrimary,
    }: {
      // index: number;
      url?: string;
      faded?: boolean;
      isPrimary?: boolean;
    }
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
      overflow: 'hidden',
    },
  })
);

const useImageStyles = createStyles(() => ({
  root: {
    position: 'absolute',
    left: '50%',
    transform: 'translateX(-50%)',
  },
}));
