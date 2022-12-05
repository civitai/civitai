export enum SocialLink {
  Reddit = 'www.reddit.com',
  Facebook = 'www.facebook.com',
  Google = 'www.google.com',
  Imgur = 'www.imgur.com',
  Instagram = '',
}

export function getSocialLinkType(url: string) {
  const { hostname } = new URL(url);
  return Object.values(SocialLink).includes(hostname as any) ? (hostname as SocialLink) : undefined;
}
