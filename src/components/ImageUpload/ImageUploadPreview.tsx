import { forwardRef, CSSProperties, useState } from 'react';
import { Alert, Center, createStyles, Paper } from '@mantine/core';
import { EdgeImage, EdgeImageProps } from '~/components/EdgeImage/EdgeImage';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { UniqueIdentifier } from '@dnd-kit/core';
import { IconArrowsMaximize } from '@tabler/icons';
import Image from 'next/image';

//TODO - handle what to display when there is an error
type Props = {
  blocked?: boolean;
  error?: boolean;
  image?: CustomFile;
  children?: React.ReactNode;
  isPrimary?: boolean;
  disabled?: boolean;
  id: UniqueIdentifier;
} & React.ComponentPropsWithoutRef<'div'>;

export const ImageUploadPreview = forwardRef<HTMLDivElement, Props>(
  ({ image, children, isPrimary, disabled, id, blocked, ...props }, ref) => { //eslint-disable-line
    const { classes } = useStyles({ isPrimary });
    const [ready, setReady] = useState(false);

    const sortable = useSortable({ id });

    const { attributes, listeners, isDragging, setNodeRef, transform, transition } = sortable;

    const style: CSSProperties = {
      transform: CSS.Transform.toString(transform),
      transition,
      cursor: isDragging ? 'grabbing' : !disabled ? 'pointer' : 'auto',
    };

    if (!image) return null;

    return (
      <Paper
        ref={setNodeRef}
        className={classes.root}
        {...props}
        radius="sm"
        style={{ ...style, ...props.style }}
      >
        {blocked ? (
          <>
            <Image
              src={'/images/nedry.gif'}
              alt="ah ah ah"
              className={classes.image}
              layout="fill"
            />
            <Alert
              variant="filled"
              color="red"
              sx={{ position: 'absolute', bottom: 0, left: 0, right: 0, textAlign: 'center' }}
              radius={0}
            >
              TOS Violation
            </Alert>
          </>
        ) : !ready && image.previewUrl ? (
          <EdgeImage src={image.previewUrl} height={410} className={classes.image} />
        ) : image.url && image.url != image.previewUrl ? (
          <EdgeImage
            src={image.url}
            height={410}
            className={classes.image}
            onLoad={() => {
              image.onLoad?.();
              setReady(true);
            }}
          />
        ) : null}

        <Center className={classes.draggable} {...listeners} {...attributes}>
          <Paper className={classes.draggableIcon} p="xl" radius={100}>
            <IconArrowsMaximize
              size={48}
              stroke={1.5}
              style={{ transform: 'rotate(45deg)' }}
              color="white"
            />
          </Paper>
        </Center>
        {children}
      </Paper>
    );
  }
);
ImageUploadPreview.displayName = 'ImagePreview';

const StyledEdgeImage = (props: EdgeImageProps) => (
  <EdgeImage
    {...props}
    height={410}
    style={{
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      objectFit: 'cover',
      objectPosition: '50% 50%',
    }}
  />
);

const useStyles = createStyles(
  (
    theme,
    {
      // index,
      faded,
      isPrimary,
    }: {
      // index: number;
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
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundColor: 'grey',
      overflow: 'hidden',
    },
    draggableIcon: {
      background: theme.fn.rgba('dark', 0.5),
      height: '120px',
      width: '120px',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
    },
    image: {
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      objectFit: 'cover',
      objectPosition: '50% 50%',
    },
    draggable: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      opacity: 0,

      // transition: '.3s ease-in-out opacity',

      ['&:hover']: {
        opacity: 1,
      },
    },
  })
);
