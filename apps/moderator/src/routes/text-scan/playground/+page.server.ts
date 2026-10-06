import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Old links (`?draft=<id>`) keep their query.
export const load: PageServerLoad = ({ url }) => {
  redirect(308, `/text-scan/check${url.search}`);
};
