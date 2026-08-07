import type { MediaType } from '~/shared/utils/prisma/enums';

// `/images` and `/videos` are separate feeds with their own filter slices, and
// each one forces its own media type (see getDefaultMediaTypes). Sending a video
// tag to `/images` therefore lands on a feed that can never contain the item the
// tag was clicked from.
export function getTagFeedHref(tagId: number, mediaType?: MediaType) {
  const feed = mediaType === 'video' ? 'videos' : 'images';
  return `/${feed}?tags=${tagId}&view=feed`;
}
