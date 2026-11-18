import type { ControlledImage } from '~/components/Post/EditV2/PostEditProvider';
import type { PostEditTextDetail } from '~/server/services/post.service';
import type { PostItemKey } from '~/shared/utils/post-items';
import { comparePostItems } from '~/shared/utils/post-items';
import { isDefined } from '~/utils/type-guards';

type EditorItem =
  | { type: 'image'; key: PostItemKey; image: ControlledImage }
  | { type: 'text'; key: PostItemKey; text: PostEditTextDetail };

/** Images and text items in reading order. Images not yet saved have no id; they sort by index. */
export function mergeEditorItems(images: ControlledImage[], texts: PostEditTextDetail[]) {
  const items: EditorItem[] = [
    ...images.map((image) => ({
      type: 'image' as const,
      key: {
        type: 'image' as const,
        id: image.type === 'added' ? image.data.id : 0,
        index: image.data.index,
      },
      image,
    })),
    ...texts.map((text) => ({
      type: 'text' as const,
      key: { type: 'text' as const, id: text.id, index: text.index },
      text,
    })),
  ];
  return items.sort((a, b) => comparePostItems(a.key, b.key));
}

/**
 * What Rearrange saves. `items` only with the flag: the server refuses it otherwise, and an
 * image-only reorder leaves text rows where they are.
 */
export function reorderPayload({
  postId,
  images,
  texts,
  textOn,
}: {
  postId: number;
  images: ControlledImage[];
  texts: PostEditTextDetail[];
  textOn: boolean;
}) {
  const imageIds = images
    .map((x) => (x.type === 'added' ? x.data.id : undefined))
    .filter(isDefined);
  if (!textOn || !texts.length) return { id: postId, imageIds };
  const items = mergeEditorItems(
    images.filter((x) => x.type === 'added'),
    texts
  ).map((item) => ({ type: item.type, id: item.key.id }));
  return { id: postId, imageIds, items };
}

/**
 * The indexes an image-only reorder gives `reordered`, in order: what the server writes
 * (`imageOnlyReorder`). On a post with text items the images trade the slots they already hold, so
 * every text keeps its place; otherwise they are numbered from 0.
 */
export function imageOnlyReorderIndexes(
  reordered: Array<{ index?: number | null }>,
  hasText: boolean
) {
  if (!hasText) return reordered.map((_, i) => i);
  return reordered.map((image) => image.index ?? 0).sort((a, b) => a - b);
}

export type SavedPosition = { type: 'image' | 'text'; id: number; index: number };

/**
 * The editor's images and texts with the indexes the server saved (`reorderPostImages`). Those can
 * differ from the editor's own when the post has images the editor does not show, which keep their
 * place; a text added next takes its index from these. An image in `sentImageIds` that the server
 * did not place is one it no longer serves this editor (rated above the cap or held since it
 * loaded), so it leaves the editor rather than keep a guessed index.
 */
export function withSavedPositions(
  images: ControlledImage[],
  texts: PostEditTextDetail[],
  positions: SavedPosition[],
  sentImageIds: number[] = []
) {
  const saved = (type: SavedPosition['type']) =>
    new Map(positions.filter((p) => p.type === type).map((p) => [p.id, p.index]));
  const imageIndex = saved('image');
  const textIndex = saved('text');
  const notPlaced = new Set(sentImageIds.filter((id) => !imageIndex.has(id)));
  return {
    images: images
      .filter((image) => !(image.type === 'added' && notPlaced.has(image.data.id)))
      .map((image) =>
        image.type === 'added' && imageIndex.has(image.data.id)
          ? ({
              ...image,
              data: { ...image.data, index: imageIndex.get(image.data.id)! },
            } as ControlledImage)
          : image
      ),
    texts: texts.map((text) =>
      textIndex.has(text.id) ? { ...text, index: textIndex.get(text.id)! } : text
    ),
  };
}
