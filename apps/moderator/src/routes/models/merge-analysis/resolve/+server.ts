import { json } from '@sveltejs/kit';
import { resolveModelLink } from '$lib/server/model-merge-analysis.service';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
  const link = url.searchParams.get('link') ?? '';
  const role = url.searchParams.get('role') === 'lora' ? 'lora' : 'checkpoint';
  return json(await resolveModelLink(link, role));
};
