import type { ServerDomains } from '~/shared/constants/domain.constants';

const normalizeHost = (host: string) => host.trim().toLowerCase().replace(/\.$/, '');

/** Every host the site answers on: each color's primary and aliases, from the domain config. */
export function getOwnHosts(serverDomains: ServerDomains | null | undefined): string[] {
  const hosts = new Set<string>();
  for (const config of Object.values(serverDomains ?? {})) {
    if (!config) continue;
    hosts.add(normalizeHost(config.primary));
    for (const alias of config.aliases) hosts.add(normalizeHost(alias));
  }
  return [...hosts];
}

/**
 * `href` moved onto `currentHost` when it points at another of our own hosts, so a link written
 * as civitai.com keeps a civitai.red reader on civitai.red and the reverse. Anything else comes
 * back untouched: relative links, other schemes, other subdomains, and every host outside
 * `ownHosts`. A bare-domain link ("https://civitai.red") is left alone too: in content and on
 * announcement buttons it is the "go to the other site" link, which only works if it keeps its
 * host.
 *
 * 🔴 Hosts are compared whole. A suffix match would accept `civitai.com.evil.test` and move
 * `orchestration.civitai.com` onto the current host. Only a host already in `ownHosts` is ever
 * replaced, and only by one also in it, so an external link can never come out looking internal.
 */
export function toCurrentDomainHref(
  href: string,
  currentHost: string | null | undefined,
  ownHosts: readonly string[]
): string {
  if (!href || !currentHost) return href;
  const current = normalizeHost(currentHost);
  if (!ownHosts.includes(current)) return href;

  let url: URL;
  try {
    // The base is a host that can never be ours, so a relative href never matches.
    url = new URL(href.trim(), 'https://invalid.');
  } catch {
    return href;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return href;
  if (url.username || url.password) return href;
  if (url.pathname === '/' && !url.search && !url.hash) return href;

  const target = normalizeHost(url.host);
  if (target === current || !ownHosts.includes(target)) return href;

  url.host = current;
  return url.href;
}

/**
 * `href` as a root-relative path ("/articles/1") when it is an http(s) link to one of `ownHosts`,
 * so it opens on whichever of our sites is being read. Anything else comes back untouched, and so
 * does a bare-domain link, which is the deliberate "go to the other site" link.
 */
export function toOwnRootRelative(href: string, ownHosts: readonly string[]): string {
  let url: URL;
  try {
    url = new URL(href.trim());
  } catch {
    return href;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return href;
  if (url.username || url.password) return href;
  if (url.pathname === '/' && !url.search && !url.hash) return href;
  if (!ownHosts.includes(normalizeHost(url.host))) return href;
  const path = `${url.pathname}${url.search}${url.hash}`;
  // A path starting "//" (or "/\", which the parser turns into one) would leave the site.
  return isSameSitePath(path) ? path : href;
}

/** Whether `href` is a path on this site: "/x", never "//host" or "/\host", which leave it. */
export function isSameSitePath(href: string): boolean {
  if (!/^\/[^/\\]/.test(href)) return false;
  try {
    return new URL(href, 'https://invalid.').host === 'invalid.';
  } catch {
    return false;
  }
}
