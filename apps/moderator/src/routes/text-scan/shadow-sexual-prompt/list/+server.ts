import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { parseQueryKeys } from '$lib/server/query';
import { getWouldRaise } from '$lib/server/shadow-sexual-prompt.service';
import { filtersSchema } from '$lib/shadow-sexual-prompt';

export const GET: RequestHandler = async ({ url }) =>
  json(await getWouldRaise(parseQueryKeys(url, filtersSchema)));
