/**
 * Whether `raw` is a plain `https:` URL: no credentials, query or fragment, and no `?` or `#` in the
 * string at all (an empty query or fragment parses to `''` but is still spelled). The App SDK's own
 * rule for `BLOCK_INIT.appData.url` (`readAppDataService` in `@civitai/sdk`): a URL it would refuse
 * reads as absent there, so the host must never send one. Used for `APP_DATA_SERVICE_PUBLIC_URL`.
 * Import-free, so the env schema can use it.
 */
export function isPlainHttpsUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') return false;
  return !raw.includes('?') && !raw.includes('#');
}
