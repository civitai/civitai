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

export function sortDomainLinks<T extends { url: string }>(links: T[]) {
  return links
    .map((link) => {
      const domain = getDomainLinkType(link.url);
      return { ...link, domain };
    })
    .sort((a, b) => sortArray.indexOf(a.domain) - sortArray.indexOf(b.domain));
}
