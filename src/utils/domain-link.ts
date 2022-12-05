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
  patreon: ['www.patreon.com'],
  koFi: ['ko-fi.com'],
  coindrop: ['coindrop.to'],
};

const sortArray = (Object.keys(domainLinks) as (string | undefined)[]).concat(undefined);

export function getDomainLinkType(url: string) {
  const { hostname } = new URL(url);
  const key = Object.entries(domainLinks).find(([key, value]) => value.includes(hostname))?.[0] as
    | DomainLink
    | undefined;
  return key;
}

console.log({ domainLinksArray: sortArray });

export function sortDomainLinks<T extends string | { url: string }>(links?: T[]) {
  return links?.sort((a, b) => {
    const typeA = getDomainLinkType(typeof a === 'string' ? a : a.url);
    const typeB = getDomainLinkType(typeof b === 'string' ? b : b.url);
    return sortArray.indexOf(typeA) - sortArray.indexOf(typeB);
  });
}
