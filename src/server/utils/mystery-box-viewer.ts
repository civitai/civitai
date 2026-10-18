import type { ProtectedContext } from '~/server/createContext';
import { getRegion } from '~/server/utils/region-blocking';

/** A signed-in viewer of mystery boxes: who they are, the `mysteryBox` flag and their country. */
export const mysteryBoxViewer = (ctx: ProtectedContext) => ({
  userId: ctx.user.id,
  isModerator: ctx.user.isModerator,
  mysteryBoxEnabled: ctx.features.mysteryBox,
  countryCode: ctx.req ? getRegion(ctx.req).countryCode : null,
});
