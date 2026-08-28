import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
  // The hooks.server.ts guard guarantees a signed-in user on this gated route.
  return { username: locals.user.username };
};
