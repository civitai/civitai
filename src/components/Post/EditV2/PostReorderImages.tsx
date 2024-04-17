import { ControlledImage, usePostImagesContext } from '~/components/Post/EditV2/PostImagesProvider';
import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  UniqueIdentifier,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button, Center, Paper, createStyles } from '@mantine/core';
import { usePrevious } from '@mantine/hooks';
import { IconArrowsMaximize, IconArrowsSort, IconCheck } from '@tabler/icons-react';
import { isEqual } from 'lodash-es';
import { CSSProperties } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import { usePostEditContext } from '~/components/Post/EditV2/PostEditor';

export function PostReorderImages() {
  const images = usePostImagesContext((state) => state.images);
  const setImages = usePostImagesContext((state) => state.setImages);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const items = images.filter((x) => x.id);

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;
    if (active.id !== over.id) {
      setImages((images) => {
        const ids = images.map((x): UniqueIdentifier => x.url);
        const oldIndex = ids.indexOf(active.id);
        const newIndex = ids.indexOf(over.id);
        const sorted = arrayMove(images, oldIndex, newIndex);
        return sorted.map((image, index) => ({ ...image, index: index + 1 }));
      });
    }
  }

  return (
    <>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={items.map((x) => x.url)}>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(3, 1fr)`, gridGap: 10 }}>
            {items.map((image) => (
              <SortableImage key={image.id} image={image} sortableId={image.url} />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      <ReorderImagesButton />
    </>
  );
}

type ItemProps = {
  image: ControlledImage;
  sortableId: UniqueIdentifier;
};

function SortableImage({ image, sortableId }: ItemProps) {
  const { attributes, listeners, isDragging, setNodeRef, transform, transition } = useSortable({
    id: sortableId,
  });

  const { classes } = useStyles();

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    cursor: isDragging ? 'grabbing' : 'pointer',
    zIndex: isDragging ? 1 : undefined,
    touchAction: 'none',
  };

  return (
    <Paper
      ref={setNodeRef}
      radius="sm"
      sx={{ overflow: 'hidden' }}
      className={classes.root}
      style={style}
      {...listeners}
      {...attributes}
    >
      <EdgeMedia src={image.url} type={image.type} width={450} className={classes.image} />
      <Center className={classes.draggable}>
        <Paper className={classes.draggableIcon} p="xl" radius={100}>
          <IconArrowsMaximize
            size={48}
            stroke={1.5}
            style={{ transform: 'rotate(45deg)' }}
            color="white"
          />
        </Paper>
      </Center>
    </Paper>
  );
}

const useStyles = createStyles((theme) => ({
  root: {
    position: 'relative',
    transformOrigin: '0 0',
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundColor: 'grey',
    overflow: 'hidden',

    '&:before': {
      content: '""',
      display: 'block',
      width: '100%',
      paddingTop: '100%',
    },
  },
  hidden: {
    opacity: 0,
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
}));

export function ReorderImagesButton() {
  const queryUtils = trpc.useUtils();
  const { post } = usePostEditContext();
  const { images, isReordering, toggleReordering } = usePostImagesContext((state) => state);

  const { mutate, isLoading } = trpc.post.reorderImages.useMutation({
    async onSuccess() {
      await queryUtils.model.getAll.invalidate();
      await queryUtils.image.getInfinite.invalidate();
    },
  });
  const previous = usePrevious(images);
  const canReorder = !!images.filter((x) => x.id).length;

  const onClick = () => {
    toggleReordering();
    if (isReordering && !!previous && !isEqual(previous, images) && post) {
      mutate({
        id: post.id,
        imageIds: images.map((x) => x.id).filter(isDefined),
      });
    }
  };

  if (images.length <= 1) return null;

  return (
    <Button
      onClick={onClick}
      disabled={!canReorder}
      loading={isLoading}
      variant={!isReordering ? 'outline' : undefined}
      leftIcon={!isReordering ? <IconArrowsSort /> : <IconCheck />}
    >
      {!isReordering ? 'Rearrange' : 'Done Rearranging'}
    </Button>
  );
}
