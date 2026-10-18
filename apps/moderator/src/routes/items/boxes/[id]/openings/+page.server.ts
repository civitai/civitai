import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { readBoxOpenings } from '$lib/server/mystery-box-builder.service';
import { int4Id } from '$lib/server/query';

export const load: PageServerLoad = async ({ params }) => {
  const boxId = int4Id.safeParse(params.id);
  if (!boxId.success) error(404, 'No such box.');
  const openings = await readBoxOpenings(boxId.data);
  if (!openings) error(404, 'No such box.');
  return openings;
};
