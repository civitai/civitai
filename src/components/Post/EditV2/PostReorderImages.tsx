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
import { Button } from '@mantine/core';
import { usePrevious } from '@mantine/hooks';
import { IconArrowsMaximize, IconArrowsSort, IconCheck } from '@tabler/icons-react';
import { isEqual } from 'lodash-es';
import { CSSProperties } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import { ControlledImage, usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';

export function PostReorderImages() {
  const [images, setImages] = usePostEditStore((state) => [
    [...state.images]
      .map((x) => (x.type === 'added' ? x.data : undefined))
      .filter(isDefined)
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0)),
    state.setImages,
  ]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const items = images.filter((x) => x.id);

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;
    if (active.id !== over.id) {
      setImages((images) => {
        const ids = images.map((x): UniqueIdentifier => x.data.url);
        const oldIndex = ids.indexOf(active.id);
        const newIndex = ids.indexOf(over.id);
        const sorted = arrayMove(images, oldIndex, newIndex);
        return sorted.map(
          (image, index) =>
            ({
              type: image.type,
              data: { ...image.data, index: index + 1 },
            } as ControlledImage)
        );
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
  image: Extract<ControlledImage, { type: 'added' }>['data'];
  sortableId: UniqueIdentifier;
};

function SortableImage({ image, sortableId }: ItemProps) {
  const { attributes, listeners, isDragging, setNodeRef, transform, transition } = useSortable({
    id: sortableId,
  });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    cursor: isDragging ? 'grabbing' : 'pointer',
    zIndex: isDragging ? 1 : undefined,
    touchAction: 'none',
  };

  return (
    <div
      ref={setNodeRef}
      className="relative aspect-square overflow-hidden rounded-md"
      style={style}
      {...listeners}
      {...attributes}
    >
      <EdgeMedia
        src={image.url}
        type={image.type}
        width={450}
        className="object-cover object-center"
      />
      <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/50 opacity-0 hover:opacity-100">
        <IconArrowsMaximize
          size={48}
          stroke={1.5}
          style={{ transform: 'rotate(45deg)' }}
          color="white"
        />
      </div>
    </div>
  );
}

export function ReorderImagesButton() {
  const queryUtils = trpc.useUtils();
  const [post, images, isReordering, toggleReordering] = usePostEditStore((state) => [
    state.post,
    state.images,
    state.isReordering,
    state.toggleReordering,
  ]);

  const { mutate, isLoading } = trpc.post.reorderImages.useMutation({
    async onSuccess() {
      await queryUtils.model.getAll.invalidate();
      await queryUtils.image.getInfinite.invalidate();
    },
  });
  const previous = usePrevious(images);
  const canReorder = !!images.every((x) => x.type === 'added');

  const onClick = () => {
    toggleReordering();
    if (isReordering && !!previous && !isEqual(previous, images) && post) {
      mutate({
        id: post.id,
        imageIds: images.map((x) => (x.type === 'added' ? x.data.id : undefined)).filter(isDefined),
      });
    }
  };

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
