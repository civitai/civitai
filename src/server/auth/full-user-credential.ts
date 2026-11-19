import { constants } from '~/server/common/constants';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

export type BearerCredential = {
  apiKeyType?: ApiKeyType | null;
  subject?: { type: 'apiKey' | 'oauth'; id: number | string } | null;
  tokenScope?: bigint | null;
};

/**
 * The one bearer credential accepted where a full user credential is required: a full-scope
 * personal (`User`) key not issued to an OAuth client.
 *
 * Callers decide first whether a bearer credential was presented at all; a browser session has
 * none and is allowed without calling this.
 */
export function isFullScopeUserKey(credential: BearerCredential | null | undefined): boolean {
  return (
    credential?.apiKeyType === ApiKeyType.User &&
    credential.subject?.type === 'apiKey' &&
    credential.tokenScope === TokenScope.Full
  );
}

/** Whether the request came from a session or carries a bearer credential `isFullScopeUserKey` accepts. */
export function isSessionOrFullUserKey(ctx: BearerCredential & { apiKeyId?: number | null }) {
  // Unlike req.context, createContext defaults tokenScope to Full for sessions,
  // so it is not a bearer marker.
  const presentedBearer = ctx.apiKeyId != null || ctx.subject != null || ctx.apiKeyType != null;
  return !presentedBearer || isFullScopeUserKey(ctx);
}

/**
 * The views a request may read content with: a moderator's only for a moderator, and the owner's
 * only on a session or a full-access key. A scoped key or an app token gets neither. The image,
 * post and collection feeds default to neither, so a caller passes these to get either.
 */
export function credentialViews(
  ctx: BearerCredential & { apiKeyId?: number | null; user?: { isModerator?: boolean } | null }
) {
  const full = isSessionOrFullUserKey(ctx);
  return { asModerator: !!ctx.user?.isModerator && full, asOwner: full };
}

/**
 * The viewer an owner-or-moderator check reads: the request's user on a session or a full-access
 * key, or a moderator whose rights the credential kept (`withModeratorRightsFor` already ran in
 * request context). Anyone else on any other key reads as no one.
 */
export function ownerOrModeratorViewer<T extends { isModerator?: boolean | null }>(
  ctx: BearerCredential & { apiKeyId?: number | null; user?: T | null }
): T | undefined {
  if (!ctx.user) return undefined;
  return ctx.user.isModerator || isSessionOrFullUserKey(ctx) ? ctx.user : undefined;
}

/**
 * Whether a moderator presenting this bearer credential loses moderator rights: they come only
 * through a full-scope personal key. The internal system account's keys are limited to read scopes
 * and keep its rights by id.
 */
export function withholdsModerator(
  user: { id: number; isModerator?: boolean | null },
  credential: BearerCredential | null | undefined
): boolean {
  if (!user.isModerator || isFullScopeUserKey(credential)) return false;
  return !(user.id === constants.system.user.id && credential?.subject?.type === 'apiKey');
}

/**
 * The viewer a request reads as: moderator rights come only with a browser session or a full-scope
 * personal key, as on the moderator procedures. Any other key reads as its user without them.
 */
export function withModeratorRightsFor<T extends { id: number; isModerator?: boolean | null }>(
  user: T | undefined,
  credential: BearerCredential & { apiKeyId?: number | null }
): T | undefined {
  if (!user?.isModerator || isSessionOrFullUserKey(credential)) return user;
  return withholdsModerator(user, credential) ? { ...user, isModerator: false } : user;
}

/**
 * The account the App Blocks AUTHOR capability is evaluated for: the request's user as the session
 * resolved it, before `withModeratorRightsFor` withheld moderator rights. That capability belongs
 * to the account (a moderator is always an author: the floor `isAppDeveloper` applies), not to the
 * credential, and the REST author routes already read it this way: they pass the bearer session's
 * own user to `isAppBlocksAuthorEnabled`.
 *
 * Read it ONLY for the author capability. It is no moderator check: `ctx.user.isModerator` is.
 * Whether the credential may call a procedure at all stays with `enforceTokenScope`.
 *
 * Falls back to `ctx.user` when the context carries no subject (a context built outside
 * `createContext`) or one for another user. No signed-in user reads as no one, so a banned
 * session (`trpcViewer` moves it to `bannedUser`) gets nothing from here.
 */
export function appBlocksAuthorAccount<T extends { id: number }>(ctx: {
  user?: T | null;
  appBlocksAuthorSubject?: T | null;
}): T | undefined {
  const user = ctx.user;
  if (!user) return undefined;
  const subject = ctx.appBlocksAuthorSubject;
  return subject && subject.id === user.id ? subject : user;
}
