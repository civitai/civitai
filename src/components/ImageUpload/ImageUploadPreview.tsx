import { forwardRef, CSSProperties } from 'react';
import { ActionIcon, Center, createStyles, Paper } from '@mantine/core';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { UniqueIdentifier } from '@dnd-kit/core';
import { IconArrowsMaximize } from '@tabler/icons';

type Props = {
  image?: CustomFile;
  children?: React.ReactNode;
  isPrimary?: boolean;
  disabled?: boolean;
  id: UniqueIdentifier;
} & React.ComponentPropsWithoutRef<'div'>;

export const ImageUploadPreview = forwardRef<HTMLDivElement, Props>(
  ({ image, children, isPrimary, disabled, id, ...props }, ref) => {
    const url = image?.url.startsWith('http') ? `${image.url}/preview` : image?.url;
    const { classes } = useStyles({ url, isPrimary });
    const { classes: imageClasses } = useImageStyles();

    const sortable = useSortable({ id });

    const { attributes, listeners, isDragging, setNodeRef, transform, transition } = sortable;

    const style: CSSProperties = {
      transform: CSS.Transform.toString(transform),
      transition,
      cursor: isDragging ? 'grabbing' : !disabled ? 'pointer' : 'auto',
    };

    if (!image) return null;
    return (
      <div
        ref={setNodeRef}
        className={classes.root}
        {...props}
        style={{ ...style, ...props.style }}
      >
        <EdgeImage className={imageClasses.root} src={image?.url} height={isPrimary ? 410 : 200} />

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
    draggableIcon: {
      background: theme.fn.rgba('dark', 0.5),
      height: '120px',
      width: '120px',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
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

const useImageStyles = createStyles(() => ({
  root: {
    position: 'absolute',
    left: '50%',
    transform: 'translateX(-50%)',
  },
}));
