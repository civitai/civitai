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
