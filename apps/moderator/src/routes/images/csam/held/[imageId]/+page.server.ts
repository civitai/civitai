import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getHeldMedia } from '$lib/server/held-media';

export const load: PageServerLoad = async ({ params }) => {
  const id = Number(params.imageId);
  if (!Number.isInteger(id) || id <= 0 || id > 2_147_483_647) error(400, 'Bad image id.');
  const media = await getHeldMedia(id);
  if (!media) error(404, 'Not available here.');
  return { item: { id, type: media.type, mimeType: media.mimeType } };
};
