export enum SocialLink {
  Reddit = 'www.reddit.com',
  Facebook = 'www.facebook.com',
  Google = 'www.google.com',
  Imgur = 'www.imgur.com',
  Instagram = '',
  Unknown = 'unknown',
}

export function getSocialLinkType(url: string) {
  const { hostname } = new URL(url);
  // console.log(Object.keys(SocialLink));
  if (Object.values(SocialLink).includes(hostname as any)) return hostname as SocialLink;
  return SocialLink.Unknown;
}
