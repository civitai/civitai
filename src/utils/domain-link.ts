export enum DomainLink {
  Reddit = 'www.reddit.com',
  Facebook = 'www.facebook.com',
  Google = 'www.google.com',
  Imgur = 'www.imgur.com',
  Instagram = '',
}

export function getDomainLinkType(url: string) {
  const { hostname } = new URL(url);
  return Object.values(DomainLink).includes(hostname as any) ? (hostname as DomainLink) : undefined;
}
