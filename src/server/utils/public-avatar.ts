import { getEdgeUrl } from '~/client-utils/edge-url';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { Flags } from '~/shared/utils/flags';

type Avatar = { url: string; nsfwLevel: number; type?: MediaType | null };

/**
 * The profile picture when every bit of its rating is inside `browsingLevel`; otherwise null.
 * `User.image` is never a fallback: it has no rating.
 */
export function avatarAtLevel<P extends { nsfwLevel: number }>(
  picture: P | null | undefined,
  browsingLevel: number
): P | null {
  if (!picture || picture.nsfwLevel === 0) return null;
  return Flags.hasFlag(browsingLevel, picture.nsfwLevel) ? picture : null;
}

/** The 96px edge URL of `avatarAtLevel`'s picture, or null. */
export function publicAvatarUrl(
  user: { username: string | null; profilePicture?: Avatar | null },
  browsingLevel: number
): string | null {
  const picture = avatarAtLevel(user.profilePicture, browsingLevel);
  if (!picture) return null;
  return getEdgeUrl(picture.url, {
    width: 96,
    name: user.username ?? undefined,
    type: picture.type ?? undefined,
  });
}

/** The user with `image` nulled and `profilePicture` held to `browsingLevel`. */
export function withPublicAvatar<U extends { profilePicture?: { nsfwLevel: number } | null }>(
  user: U,
  browsingLevel: number
) {
  return {
    ...user,
    image: null,
    profilePicture: avatarAtLevel(user.profilePicture, browsingLevel),
  };
}
