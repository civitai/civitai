import { abbreviateNumber } from '~/utils/number-helpers';

type ProfileCounts = {
  modelCount?: number | null;
  imageCount?: number | null;
  videoCount?: number | null;
  articleCount?: number | null;
  comicCount?: number | null;
};

export function buildProfileMeta({
  username,
  overview,
  followers = 0,
}: {
  username: string;
  overview?: ProfileCounts | null;
  followers?: number | null;
}) {
  const counts: [number, string][] = [
    [overview?.modelCount ?? 0, 'AI models'],
    [overview?.imageCount ?? 0, 'images'],
    [overview?.videoCount ?? 0, 'videos'],
    [overview?.articleCount ?? 0, 'articles'],
    [overview?.comicCount ?? 0, 'comics'],
  ];
  const has = counts
    .filter(([count]) => count > 0)
    .sort((a, b) => b[0] - a[0])
    .slice(0, 2)
    .map(([count, noun]) => `${abbreviateNumber(count)} ${noun}`);

  if (!has.length)
    return {
      title: `${username} | AI Creator on Civitai`,
      description: `Browse ${username}'s AI models, images and articles on Civitai. Download or generate online.`,
    };

  const following = followers ? `, followed by ${abbreviateNumber(followers)} people` : '';
  return {
    title: `${username}: ${has.join(' and ')} | Civitai`,
    description: `${username} on Civitai: ${has.join(
      ' and '
    )}${following}. Download or generate online.`,
  };
}
