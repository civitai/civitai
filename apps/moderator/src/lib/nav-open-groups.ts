export const NAV_OPEN_COOKIE = 'mod-nav-open';

export function parseOpenNavGroups(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    return raw.split(',').filter(Boolean).map(decodeURIComponent);
  } catch {
    // A malformed cookie would otherwise fail every page load.
    return [];
  }
}

export function writeOpenNavGroups(labels: string[]) {
  const value = labels.map(encodeURIComponent).join(',');
  document.cookie = `${NAV_OPEN_COOKIE}=${value}; path=/; max-age=31536000; samesite=lax`;
}
