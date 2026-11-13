// `.com` can refuse the very item being moderated (see `civitaiLinkUrl`). Only the site itself: image,
// hq, moderator and the other subdomains are separate services with no `.red` twin.
const MAIN_SITE_HOSTS = new Set(['civitai.com', 'www.civitai.com']);

/** `href` moved onto `base` when it points at the main site; anything else unchanged. */
export function toLinkBase(href: string, base: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  if (!MAIN_SITE_HOSTS.has(url.hostname)) return href;
  return `${base}${url.pathname}${url.search}${url.hash}`;
}
