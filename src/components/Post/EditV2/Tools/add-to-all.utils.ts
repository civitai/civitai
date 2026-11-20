import type { ControlledImage } from '~/components/Post/EditV2/PostEditProvider';
import { MediaType } from '~/shared/utils/prisma/enums';

/** The footer action that applies a tool or technique to every item of the post. */
export function addToAllLabel(items: ControlledImage[]) {
  const noun = items.every((x) => x.data.type === MediaType.image) ? 'images' : 'items';
  return `Add to all ${noun} (${items.length})`;
}
