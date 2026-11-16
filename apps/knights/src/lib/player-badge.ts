export type PlayerBadge = { username: string; avatarUrl: string | null; profileUrl: string };

const AVATAR_SIZE_PX = 48; // 24px shown, 2x for dense displays

/**
 * What the nav may show about the signed-in player. `image` is a Civitai image key or a full URL.
 * Returns null without a username so the nav renders nothing.
 */
export function playerBadge(
  user: { username?: string; image?: string } | undefined,
  civitaiUrl: string,
  keyToUrl: (key: string, width: number) => string
): PlayerBadge | null {
  const username = user?.username?.trim();
  if (!username) return null;
  const image = user?.image?.trim();
  const avatarUrl = !image
    ? null
    : /^https?:\/\//i.test(image)
    ? image
    : keyToUrl(image, AVATAR_SIZE_PX);
  return { username, avatarUrl, profileUrl: `${civitaiUrl}/user/${encodeURIComponent(username)}` };
}
