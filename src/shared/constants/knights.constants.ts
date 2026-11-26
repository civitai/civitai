export const KNIGHTS_APP_URL = 'https://knights.civitai.com';

// The Knights app's own access flag (`apps/knights/src/lib/server/access.ts`). Enabling it for all users
// is the launch, and the cutover from the old in-app game.
export const KNIGHTS_APP_FLIPT_FLAG = 'knights-of-new-order-app';

const OLD_GAME_HREF = '/games/knights-of-new-order';

// The nav item and the browsing-mode button share this. `knightsApp` links to the app for whoever it
// admits; otherwise the old game keeps its own link. `isBlue` keeps the app link off the SFW (green) site.
export function getKnightsLink(flags: {
  knightsApp?: boolean;
  newOrderGame?: boolean;
  isBlue?: boolean;
}) {
  if (flags.knightsApp && flags.isBlue) return { href: KNIGHTS_APP_URL, visible: true };
  if (flags.newOrderGame) return { href: OLD_GAME_HREF, visible: true };
  return { href: OLD_GAME_HREF, visible: false };
}
