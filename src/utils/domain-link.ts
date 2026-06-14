export type DomainLink = keyof typeof domainLinks;
export const domainLinks = {
  huggingFace: ['huggingface.co'],
  twitter: ['twitter.com'],
  x: ['x.com'],
  twitch: ['twitch.tv'],
  reddit: ['reddit.com'],
  youtube: ['youtube.com'],
  facebook: ['facebook.com'],
  instagram: ['instagram.com'],
  buyMeACoffee: ['buymeacoffee.com'],
  patreon: ['patreon.com'],
  koFi: ['ko-fi.com'],
  coindrop: ['coindrop.to'],
  discord: ['discord.gg', 'discord.com'],
  github: ['github.com'],
  linktree: ['linktr.ee'],
  deviantArt: ['deviantart.com'],
  tumblr: ['tumblr.com'],
  telegram: ['t.me'],
  vk: ['vk.com'],
  bilibili: ['bilibili.com'],
  civitai: ['civitai.com'],
  linkedin: ['linkedin.com'],
};

const sortArray = (Object.keys(domainLinks) as (string | undefined)[]).concat(undefined);

export function getDomainLinkType(url: string) {
  let { hostname } = new URL(url);
  hostname = hostname.split('.').slice(-2).join('.');
  const key = Object.entries(domainLinks).find(([key, value]) => value.includes(hostname))?.[0] as  //eslint-disable-line
    | DomainLink
    | undefined;
  return key;
}

// Human-readable platform names for the known domain keys (for accessible labels).
const domainDisplayNames: Record<DomainLink, string> = {
  huggingFace: 'Hugging Face',
  twitter: 'Twitter',
  x: 'X',
  twitch: 'Twitch',
  reddit: 'Reddit',
  youtube: 'YouTube',
  facebook: 'Facebook',
  instagram: 'Instagram',
  buyMeACoffee: 'Buy Me a Coffee',
  patreon: 'Patreon',
  koFi: 'Ko-fi',
  coindrop: 'Coindrop',
  discord: 'Discord',
  github: 'GitHub',
  linktree: 'Linktree',
  deviantArt: 'DeviantArt',
  tumblr: 'Tumblr',
  telegram: 'Telegram',
  vk: 'VK',
  bilibili: 'Bilibili',
  civitai: 'Civitai',
  linkedin: 'LinkedIn',
};

/** Accessible label for an external creator link icon, e.g. "Discord profile" or "example.com profile". */
export function getDomainLinkLabel(link: { url: string; domain?: DomainLink }): string {
  const domain = link.domain ?? getDomainLinkType(link.url);
  if (domain) return `${domainDisplayNames[domain]} profile`;
  try {
    return `${new URL(link.url).hostname.replace(/^www\./, '')} profile`;
  } catch {
    return 'External profile link';
  }
}

export function sortDomainLinks<T extends { url: string }>(links: T[]) {
  return links
    .map((link) => {
      const domain = getDomainLinkType(link.url);
      return { ...link, domain };
    })
    .sort((a, b) => sortArray.indexOf(a.domain) - sortArray.indexOf(b.domain));
}
