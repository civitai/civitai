/**
 * A post's reading order when storyline text items sit between its images. Both share
 * `Image.index`'s number space; a text item takes the index of the item it follows, so on a tie
 * the image comes first, then text items by id (`addPostText`).
 */
export type PostItemKey = { type: 'image' | 'text'; id: number; index?: number | null };

export function comparePostItems(a: PostItemKey, b: PostItemKey) {
  const byIndex = (a.index ?? 0) - (b.index ?? 0);
  if (byIndex) return byIndex;
  if (a.type !== b.type) return a.type === 'image' ? -1 : 1;
  return a.id - b.id;
}

/** The index for a text item added after `previous`, or before every item when it is absent. */
export function textIndexAfter(previous: PostItemKey | undefined, first: PostItemKey | undefined) {
  if (previous) return previous.index ?? 0;
  return (first?.index ?? 0) - 1;
}
