import type { Context, ProtectedContext } from '~/server/createContext';
import { eventViewerOf } from '~/server/events/event-viewer';
import { getRegion } from '~/server/utils/region-blocking';

/**
 * A signed-in viewer of mystery boxes: who they are, the `mysteryBox` flag and their country.
 * `isModerator` is eventViewerOf's, so a scoped token does not carry it.
 */
export const mysteryBoxViewer = (ctx: ProtectedContext) => ({
  userId: ctx.user.id,
  isModerator: eventViewerOf(ctx).isModerator,
  mysteryBoxEnabled: ctx.features.mysteryBox,
  countryCode: ctx.req ? getRegion(ctx.req).countryCode : null,
});

/** A viewer of the public box reads, signed in or not. */
export const publicMysteryBoxViewer = (ctx: Context) => ({
  viewer: ctx.user ? eventViewerOf(ctx) : undefined,
  mysteryBoxEnabled: ctx.features.mysteryBox,
  countryCode: ctx.req ? getRegion(ctx.req).countryCode : null,
});
