import { comparePostItems } from '~/shared/utils/post-items';

/** The URL param naming the text slide on screen; the path keeps the image before it. */
export const TEXT_SLIDE_PARAM = 'text';

/** A storyline text item as the viewer shows it. `content` is absent on path stubs until `post.get` lands. */
export type DetailText = {
  id: number;
  postId: number;
  index: number;
  nsfwLevel: number;
  content?: string;
};

type Placed = { id: number; postId: number | null; index: number | null };

export type DetailItem<I extends Placed> =
  | { type: 'image'; key: string; image: I }
  | { type: 'text'; key: string; text: DetailText };

/**
 * `ImageGuardContent` keys its reveal state by a numeric id in the same store images use. A text
 * slide passes the negated text id: image ids are positive, so the two never collide. Anything that
 * reads guard state by id must not treat a negative id as an image.
 */
export function textGuardId(textId: number) {
  return -textId;
}

/**
 * The viewer's slides: `images` in their own order, with each text placed after the items of its
 * post that sort before it (`comparePostItems`). Images never move among themselves, so with no
 * texts this is `images` one for one. `postOrder` orders posts (a storyline path); without it a
 * post sits where its first image does. A text whose post has no image here goes after the last
 * item of the posts before it.
 */
export function mergeDetailItems<I extends Placed>(
  images: I[],
  texts: DetailText[] | undefined,
  postOrder?: number[]
): DetailItem<I>[] {
  const items: DetailItem<I>[] = images.map((image) => ({
    type: 'image',
    key: `img:${image.id}`,
    image,
  }));
  if (!texts?.length) return items;

  const position = new Map<number, number>();
  for (const postId of postOrder ?? images.map((image) => image.postId)) {
    if (postId != null && !position.has(postId)) position.set(postId, position.size);
  }
  const positionOf = (postId: number | null) =>
    postId != null ? position.get(postId) ?? Infinity : Infinity;
  const keyOf = (item: DetailItem<I>) =>
    item.type === 'image'
      ? { post: positionOf(item.image.postId), type: 'image' as const, ...item.image }
      : { post: positionOf(item.text.postId), type: 'text' as const, ...item.text };
  const compare = (a: DetailItem<I>, b: DetailItem<I>) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka.post !== kb.post) return ka.post < kb.post ? -1 : 1;
    return comparePostItems(ka, kb);
  };

  const sorted = texts
    .filter((text) => postOrder === undefined || position.has(text.postId))
    .map((text): DetailItem<I> => ({ type: 'text', key: `txt:${text.id}`, text }))
    .sort(compare);
  for (const text of sorted) {
    const at = items.findIndex((item) => compare(item, text) > 0);
    if (at === -1) items.push(text);
    else items.splice(at, 0, text);
  }
  return items;
}

/** The image a slide's URL names: the slide itself, else the image before it, else the one after. */
export function anchorImageIndex<I extends Placed>(items: DetailItem<I>[], index: number) {
  for (let i = index; i >= 0; i--) if (items[i]?.type === 'image') return i;
  for (let i = index + 1; i < items.length; i++) if (items[i].type === 'image') return i;
  return -1;
}

export function itemPostId<I extends Placed>(item: DetailItem<I> | undefined) {
  if (!item) return undefined;
  return item.type === 'image' ? item.image.postId ?? undefined : item.text.postId;
}
