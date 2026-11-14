import type { DragEndEvent, UniqueIdentifier } from '@dnd-kit/core';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '@mantine/core';
import { usePrevious } from '@mantine/hooks';
import { IconArrowsMaximize, IconArrowsSort, IconCheck } from '@tabler/icons-react';
import { isEqual } from 'lodash-es';
import type { CSSProperties } from 'react';
import { BrowsingLevelBadge } from '~/components/BrowsingLevel/BrowsingLevelBadge';
import { ImageReactionCount } from '~/components/Post/EditV2/PostImageCards/ImageReactionCount';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useImageStore } from '~/store/image.store';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import type { ControlledImage } from '~/components/Post/EditV2/PostEditProvider';
import { usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import {
  imageOnlyReorderIndexes,
  mergeEditorItems,
  reorderPayload,
} from '~/components/Post/EditV2/post-edit-items';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { PostEditTextDetail } from '~/server/services/post.service';

export function PostReorderImages() {
  const textOn = !!useFeatureFlags().storylineText;
  const texts = usePostEditStore((state) => state.texts);
  if (textOn && texts.length) return <PostReorderItems />;
  return <PostReorderImagesOnly />;
}

const textSortableId = (id: number) => `text-${id}`;

/** Images and text items in one sortable list; a drop renumbers both to their new positions. */
function PostReorderItems() {
  const [images, texts, setImages, setTexts] = usePostEditStore((state) => [
    state.images,
    state.texts,
    state.setImages,
    state.setTexts,
  ]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const items = mergeEditorItems(
    images.filter((x) => x.type === 'added' && x.data.id),
    texts
  );
  const sortableId = (item: (typeof items)[number]) =>
    item.type === 'text' ? textSortableId(item.text.id) : item.image.data.url;

  function handleDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const oldIndex = items.findIndex((x) => sortableId(x) === active.id);
    const newIndex = items.findIndex((x) => sortableId(x) === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const order = arrayMove(items, oldIndex, newIndex);
    const imageIndex = new Map<number, number>();
    const textIndex = new Map<number, number>();
    order.forEach((item, index) =>
      item.type === 'text' ? textIndex.set(item.text.id, index) : imageIndex.set(item.key.id, index)
    );
    setImages((storeImages) =>
      storeImages.map((x) =>
        x.type === 'added' && imageIndex.has(x.data.id)
          ? ({ ...x, data: { ...x.data, index: imageIndex.get(x.data.id)! } } as ControlledImage)
          : x
      )
    );
    setTexts((storeTexts) =>
      storeTexts.map((t) => (textIndex.has(t.id) ? { ...t, index: textIndex.get(t.id)! } : t))
    );
  }

  return (
    <>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={items.map(sortableId)}>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(3, 1fr)`, gridGap: 10 }}>
            {items.map((item) =>
              item.type === 'text' ? (
                <SortableText
                  key={sortableId(item)}
                  text={item.text}
                  sortableId={sortableId(item)}
                />
              ) : (
                <SortableImage
                  key={sortableId(item)}
                  image={(item.image as Extract<ControlledImage, { type: 'added' }>).data}
                  sortableId={sortableId(item)}
                />
              )
            )}
          </div>
        </SortableContext>
      </DndContext>
      <ReorderImagesButton />
    </>
  );
}

function useSortableStyle(sortableId: UniqueIdentifier) {
  const sortable = useSortable({ id: sortableId });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    cursor: sortable.isDragging ? 'grabbing' : 'pointer',
    zIndex: sortable.isDragging ? 1 : undefined,
    touchAction: 'none',
  };
  return { ...sortable, style };
}

function SortableText({ text, sortableId }: { text: PostEditTextDetail; sortableId: string }) {
  const { attributes, listeners, setNodeRef, style } = useSortableStyle(sortableId);
  return (
    <div
      ref={setNodeRef}
      className="relative aspect-square overflow-hidden rounded-md border border-solid border-gray-3 bg-gray-0 p-3 dark:border-dark-4 dark:bg-dark-6"
      style={style}
      data-testid="sortable-text"
      {...listeners}
      {...attributes}
    >
      <div className="h-full overflow-hidden text-sm">
        {text.content ? <RenderHtml html={text.content} /> : <em>Empty text</em>}
      </div>
      {/* Fades a long text out at the tile's foot instead of cutting a line in half. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-gray-0 dark:from-dark-6" />
    </div>
  );
}

function PostReorderImagesOnly() {
  const [images, setImages] = usePostEditStore((state) => [
    [...state.images]
      .map((x) => (x.type === 'added' ? x.data : undefined))
      .filter(isDefined)
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0)),
    state.setImages,
  ]);
  // Text items the editor does not show (their flag is off) still hold slots on the server.
  const hasText = usePostEditStore((state) => state.texts.length > 0);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const items = images.filter((x) => x.id);

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;
    if (active.id !== over.id) {
      setImages((storeImages) => {
        // Filter and sort the same way as the displayed images
        const addedImages = storeImages
          .filter((x) => x.type === 'added' && x.data.id)
          .sort((a, b) => (a.data.index ?? 0) - (b.data.index ?? 0));

        // Find indices in the sorted, filtered array (matching what's displayed)
        const oldIndex = addedImages.findIndex((x) => x.data.url === active.id);
        const newIndex = addedImages.findIndex((x) => x.data.url === over.id);

        if (oldIndex === -1 || newIndex === -1) return storeImages;

        // Reorder the added images
        const reordered = arrayMove(addedImages, oldIndex, newIndex);

        // The indexes the server will write, so text items keep their places.
        const indexes = imageOnlyReorderIndexes(
          reordered.map((image) => image.data),
          hasText
        );
        const updatedImages = reordered.map(
          (image, i) =>
            ({
              type: image.type,
              data: { ...image.data, index: indexes[i] },
            } as ControlledImage)
        );

        // Merge back with non-added images
        const nonAddedImages = storeImages.filter((x) => x.type !== 'added' || !x.data.id);
        return [...updatedImages, ...nonAddedImages];
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
  const { attributes, listeners, setNodeRef, style } = useSortableStyle(sortableId);
  const { nsfwLevel } = useImageStore(image);

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
      {!!nsfwLevel && (
        <BrowsingLevelBadge
          browsingLevel={nsfwLevel}
          size="lg"
          className="pointer-events-none absolute left-2 top-2 z-20"
        />
      )}
      <ImageReactionCount
        count={image.reactionCount}
        className="pointer-events-none absolute bottom-2 left-2 z-20"
      />
    </div>
  );
}

export function ReorderImagesButton() {
  const queryUtils = trpc.useUtils();
  const textOn = !!useFeatureFlags().storylineText;
  const [post, images, texts, isReordering, toggleReordering] = usePostEditStore((state) => [
    state.post,
    state.images,
    state.texts,
    state.isReordering,
    state.toggleReordering,
  ]);

  const { mutate, isPending: isLoading } = trpc.post.reorderImages.useMutation({
    async onSuccess() {
      await queryUtils.model.getAll.invalidate();
      await queryUtils.image.getInfinite.invalidate();
    },
  });
  const previous = usePrevious({ images, texts });
  const canReorder = !!images.every((x) => x.type === 'added');

  const onClick = () => {
    toggleReordering();
    if (!isReordering || !previous || isEqual(previous, { images, texts }) || !post) return;
    mutate(reorderPayload({ postId: post.id, images, texts, textOn }));
  };

  return (
    <Button
      onClick={onClick}
      disabled={!canReorder}
      loading={isLoading}
      variant={!isReordering ? 'outline' : undefined}
      leftSection={!isReordering ? <IconArrowsSort /> : <IconCheck />}
    >
      {!isReordering ? 'Rearrange' : 'Done Rearranging'}
    </Button>
  );
}
