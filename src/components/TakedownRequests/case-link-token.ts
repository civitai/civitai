export const CASE_LINK_KEY = 'civ-case-link';

/**
 * The token the case page's head script left for this case, removed as it is read, so no later script in
 * the tab can find it whatever the exchange answers. The caller keeps it in memory for a retry.
 */
export function takeCaseLinkToken(publicRef: string, storage: Storage = sessionStorage) {
  const key = `${CASE_LINK_KEY}:${publicRef}`;
  try {
    const token = storage.getItem(key);
    storage.removeItem(key);
    return token;
  } catch {
    return null;
  }
}

/**
 * The case page's inline head script. It runs as the head parses, before any app or third-party script
 * can read the address: it takes the link token out of the URL and history and, for a valid reference,
 * leaves it in sessionStorage for the case view. It runs whether or not the page can show the case.
 */
export function stripLinkTokenScript(publicRef: string | null) {
  const keep = publicRef
    ? `try{sessionStorage.setItem(${JSON.stringify(
        `${CASE_LINK_KEY}:${publicRef}`
      )},decodeURIComponent(m[1]))}catch(e){}`
    : '';
  return `(function(){var m=/[#&]t=([^&]+)/.exec(location.hash);if(!m)return;${keep}history.replaceState(null,'',location.pathname)})();`;
}
