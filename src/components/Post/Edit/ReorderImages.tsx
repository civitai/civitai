import { useEditPostContext } from './EditPostProvider';
import { useState, CSSProperties } from 'react';
import {
  useSensors,
  useSensor,
  PointerSensor,
  DndContext,
  closestCenter,
  DragEndEvent,
  UniqueIdentifier,
  DragStartEvent,
  DragOverlay,
} from '@dnd-kit/core';
import { arrayMove, SortableContext, useSortable } from '@dnd-kit/sortable';
import { isDefined } from '~/utils/type-guards';
import { Button, Center, createStyles, Paper } from '@mantine/core';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { useDidUpdate } from '@mantine/hooks';
import { trpc } from '~/utils/trpc';
import { CSS } from '@dnd-kit/utilities';
import { IconArrowsMaximize, IconCheck } from '@tabler/icons-react';
import { PostEditImage } from '~/server/controllers/post.controller';

export function ReorderImages() {
  const [activeId, setActiveId] = useState<UniqueIdentifier>();

  const images = useEditPostContext((state) => state.images);
  const setImages = useEditPostContext((state) => state.setImages);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const items = images
    .map((x) => {
      if (x.type === 'image') return x.data;
    })
    .filter(isDefined);
  const activeItem = items.find((x) => x.id === activeId);

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
        onDragStart={handleDragStart}
        onDragCancel={handleDragCancel}
      >
        <SortableContext items={items.map((x) => x.id)}>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(3, 1fr)`, gridGap: 10 }}>
            {items.map((image) => (
              <SortableImage
                key={image.id}
                image={image}
                sortableId={image.id}
                activeId={activeId}
              />
            ))}
          </div>
        </SortableContext>
        <DragOverlay adjustScale>
          {activeItem && <SortableImage sortableId="selected" image={activeItem} />}
        </DragOverlay>
      </DndContext>
      <ReorderImagesButton>
        {({ onClick, isLoading }) => (
          <Button onClick={onClick} loading={isLoading} leftIcon={<IconCheck />}>
            Done Rearranging
          </Button>
        )}
      </ReorderImagesButton>
    </>
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;
    if (active.id !== over.id) {
      setImages((images) => {
        const ids = images.map((x): UniqueIdentifier => x.id);
        const oldIndex = ids.indexOf(active.id);
        const newIndex = ids.indexOf(over.id);
        const sorted = arrayMove(images, oldIndex, newIndex);
        return sorted;
      });
    }
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id);
  }

  function handleDragCancel() {
    setActiveId(undefined);
  }
}

function SortableImage({
  image,
  sortableId,
  activeId,
}: {
  image: PostEditImage;
  sortableId: UniqueIdentifier;
  activeId?: UniqueIdentifier;
}) {
  const sortable = useSortable({ id: sortableId });
  const { attributes, listeners, isDragging, setNodeRef, transform, transition } = sortable;
  const { classes, cx } = useStyles();

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    cursor: isDragging ? 'grabbing' : 'pointer',
  };

  return (
    <Paper
      ref={setNodeRef}
      radius="sm"
      sx={{ overflow: 'hidden' }}
      className={cx(classes.root, { [classes.hidden]: activeId === sortableId && isDragging })}
      style={style}
    >
      <EdgeImage src={image.previewUrl ?? image.url} width={450} className={classes.image} />
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

export function ReorderImagesButton({
  children,
}: {
  children: ({
    onClick,
    isLoading,
    isReordering,
    canReorder,
  }: {
    onClick: () => void;
    isLoading: boolean;
    isReordering: boolean;
    canReorder: boolean;
  }) => React.ReactElement;
}) {
  const id = useEditPostContext((state) => state.id);
  const images = useEditPostContext((state) => state.images);
  const isReordering = useEditPostContext((state) => state.reorder);
  const toggleReorder = useEditPostContext((state) => state.toggleReorder);
  const { mutate, isLoading } = trpc.post.reorderImages.useMutation();

  const onClick = () => {
    toggleReorder();
  };

  useDidUpdate(() => {
    if (!isReordering) {
      mutate({
        id,
        imageIds: images
          .map((x) => {
            if (x.type === 'image') return x.data.id;
          })
          .filter(isDefined),
      });
    }
  }, [isReordering]);

  return children({
    onClick,
    isLoading,
    isReordering,
    canReorder: !images.filter((x) => x.type === 'upload').length,
  });
}
