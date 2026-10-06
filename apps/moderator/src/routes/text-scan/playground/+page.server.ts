import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Old links (`?draft=<id>`) keep their query.
export const load: PageServerLoad = ({ url }) => {
  redirect(307, `/text-scan/check${url.search}`);
};
