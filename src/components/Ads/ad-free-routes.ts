const blockedUrls: string[] = [
  '/collections/6503138',
  '/collections/7514194',
  '/collections/7514211',
  '/moderator',
];

/** Pages that never load the ad stack, whatever else allows it. */
export function isAdFreeRoute(pathname: string, asPath: string) {
  return (
    blockedUrls.some((url) => asPath.includes(url)) ||
    // The gift claim page holds a live gift code in its props, readable by any script on the page.
    pathname.startsWith('/gift/') ||
    // A takedown request carries the submitter's contact details, and the case page a private link.
    pathname === '/requests' ||
    pathname.startsWith('/requests/') ||
    asPath.split('?')[0].endsWith('/edit')
  );
}
