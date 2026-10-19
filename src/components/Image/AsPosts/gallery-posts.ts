import { mergePostImages } from '~/components/Image/AsPosts/lazyPostImages';

type PostCard = {
  postId: number;
  sponsored?: boolean;
  images: { id: number }[];
  imageCount?: number;
};

// Gallery pages are cut by image, so under a reaction or comment sort one post's images can rank
// onto several pages. A post keeps the card where it first appeared, and any of its images a
// later page brings are added to that card rather than shown as a second one.
// A sponsored card holds only the images its host approved and skips the gallery's hidden
// settings, so it is never merged with the post's ordinary cards.
export function mergePostPages<T extends PostCard>(pages: (T[] | undefined)[]) {
  const cardIndex = new Map<number, number>();
  const posts: T[] = [];
  for (const page of pages) {
    for (const post of page ?? []) {
      if (post.sponsored) {
        posts.push(post);
        continue;
      }
      const at = cardIndex.get(post.postId);
      if (at === undefined) {
        cardIndex.set(post.postId, posts.length);
        posts.push(post);
        continue;
      }
      const card = posts[at];
      const images = mergePostImages(card.images, post.images);
      // Each page counts only the images it ranked, and an image ranks on one page, so the
      // counts add up; images both cards already carried are counted once.
      const repeated = card.images.length + post.images.length - images.length;
      const imageCount =
        card.imageCount !== undefined
          ? card.imageCount + (post.imageCount ?? post.images.length) - repeated
          : undefined;
      if (images.length === card.images.length && imageCount === card.imageCount) continue;
      posts[at] = { ...card, images, ...(imageCount !== undefined && { imageCount }) };
    }
  }
  return posts;
}
