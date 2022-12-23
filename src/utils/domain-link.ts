export type DomainLink = keyof typeof domainLinks;
export const domainLinks = {
  huggingFace: ['huggingface.co'],
  twitter: ['twitter.com'],
  twitch: ['twitch.tv'],
  reddit: ['reddit.com', 'www.reddit.com'],
  youtube: ['youtube.com', 'www.youtube.com'],
  facebook: ['www.facebook.com'],
  instagram: ['www.instagram.com'],
  buyMeACoffee: ['www.buymeacoffee.com'],
  patreon: ['patreon.com', 'www.patreon.com'],
  koFi: ['ko-fi.com'],
  coindrop: ['coindrop.to'],
  discord: ['discord.gg'],
  github: ['github.com'],
  linktree: ['linktr.ee'],
  deviantArt: ['www.deviantart.com', 'deviantart.com'],
};

const sortArray = (Object.keys(domainLinks) as (string | undefined)[]).concat(undefined);

export function getDomainLinkType(url: string) {
  const { hostname } = new URL(url);
  const key = Object.entries(domainLinks).find(([key, value]) => value.includes(hostname))?.[0] as  //eslint-disable-line
    | DomainLink
    | undefined;
  return key;
}

export function sortDomainLinks<T extends { url: string }>(links?: T[]) {
  return links
    ?.map((link) => {
      const domain = getDomainLinkType(link.url);
      return { ...link, domain };
    })
    .sort((a, b) => sortArray.indexOf(a.domain) - sortArray.indexOf(b.domain));
}
