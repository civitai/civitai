export enum SocialLink {
  Reddit = 'www.reddit.com',
  Facebook = 'www.facebook.com',
  Imgur = 'www.imgur.com',
  Unknown = 'unknown',
}

export function getSocialLinkType(url: string) {
  const { hostname } = new URL(url);
  if (hostname in SocialLink) return hostname as SocialLink;
  return SocialLink.Unknown;
}
