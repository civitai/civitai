import { parseCheckInput } from '$lib/text-scan-lab/input';

/** More links than any ticket is about; keeps a pasted log from costing a parse per word. */
const MAX_LINKS = 100;

const IMAGE_LINK = /^(?:https?:\/\/)?(?:www\.)?civitai\.(?:com|red|green)\/images\/(\d+)/i;

export type Mentions = { images: Set<number>; posts: Set<number>; models: Set<number> };

/**
 * The images, posts and models a ticket's text links to. Models and posts go through the text-scan
 * lab's link parser; it has no image route, so image links are matched here.
 */
export function mentionKeys(text: string): Mentions {
  const found: Mentions = { images: new Set(), posts: new Set(), models: new Set() };
  const tokens = text
    .split(/[\s,]+/)
    .filter((t) => /civitai\.(com|red|green)/i.test(t))
    .slice(0, MAX_LINKS);
  for (const raw of tokens) {
    const token = raw.replace(/^[(<'"]+/, '');
    const image = IMAGE_LINK.exec(token);
    if (image) {
      found.images.add(Number(image[1]));
      continue;
    }
    const parsed = parseCheckInput(token);
    if (parsed.kind !== 'entity') continue;
    if (parsed.entityType === 'Post') parsed.ids.forEach((id) => found.posts.add(id));
    else if (parsed.entityType === 'Model') parsed.ids.forEach((id) => found.models.add(id));
  }
  return found;
}
