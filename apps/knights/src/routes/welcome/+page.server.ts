import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => ({ signInUrl: locals.signInUrl ?? '/' });
