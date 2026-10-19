import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { catalogQuerySchema } from '$lib/server/catalog-query';
import { searchCosmeticCatalog } from '$lib/server/item-definitions.service';
import { int4Id, parseQuery } from '$lib/server/query';

export const GET: RequestHandler = async ({ params, url }) => {
  if (!int4Id.safeParse(params.id).success) error(404, 'No such box.');
  return json(await searchCosmeticCatalog(parseQuery(url, catalogQuerySchema)));
};
