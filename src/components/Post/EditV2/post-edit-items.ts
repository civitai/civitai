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
