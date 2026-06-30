import type { PageServerLoad } from './$types';

// The guard in hooks.server.ts guarantees `locals.user` is a moderator by the time we get here —
// surface a little identity for the landing chrome.
export const load: PageServerLoad = ({ locals }) => {
  return {
    moderator: {
      id: locals.user?.id ?? null,
      username: locals.user?.username ?? null,
    },
  };
};
