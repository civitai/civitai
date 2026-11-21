const blockedUrls: string[] = [
  '/collections/6503138',
  '/collections/7514194',
  '/collections/7514211',
  '/moderator',
];

const isRequestsPath = (path: string) => path === '/requests' || path.startsWith('/requests/');

/** A takedown request page or the private case page, by route or by address. */
export const isRequestsRoute = (pathname: string, asPath: string) =>
  isRequestsPath(pathname) || isRequestsPath(asPath.split(/[?#]/)[0]);

/** Pages that never load the ad stack, whatever else allows it. */
export function isAdFreeRoute(pathname: string, asPath: string) {
  const path = asPath.split(/[?#]/)[0];
  return (
    blockedUrls.some((url) => asPath.includes(url)) ||
    // The gift claim page holds a live gift code in its props, readable by any script on the page.
    pathname.startsWith('/gift/') ||
    // A takedown request carries the submitter's contact details, and the case page a private link.
    // By the address as well as the route, so a /404 rendered for a request URL stays ad-free too.
    isRequestsRoute(pathname, asPath) ||
    path.endsWith('/edit')
  );
}
