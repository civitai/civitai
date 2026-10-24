import { accountSections, getAccountSectionHref } from '~/components/Account/account-sections';

/**
 * `?setting=<id>` scrolls to and highlights that element id; `#<id>` is read the same way. Hand out
 * the query form: a fragment never reaches the server, so login drops it for a signed-out visitor.
 * Format and anchor list: docs/features/account-settings-links.md.
 */
export const SETTING_PARAM = 'setting';

/** Pane that renders each anchor, for links that name none. `setting-links.test.ts` fails when an entry matches no id or title in the components. */
export const settingPanes: Record<string, string> = {
  'account-info': 'profile',
  'creator-profile': 'profile',
  'account-standing': 'profile',
  'refresh-session': 'profile',
  'delete-account': 'profile',

  'media-playback': 'preferences',
  generation: 'preferences',
  'file-preferences': 'preferences',
  'civbot-assistant': 'preferences',
  privacy: 'preferences',
  'hide-reaction-lists': 'preferences',
  features: 'preferences',

  delivery: 'notifications',

  ads: 'content',
  'mature-content': 'content',
  topics: 'content',
  'hidden-tags': 'content',
  'hidden-users': 'content',

  'metric-visibility': 'creator',
  stickers: 'creator',

  'manage-subscription': 'billing',
  'payment-methods': 'billing',
  payments: 'billing',
  'membership-gifts': 'billing',

  accounts: 'security',
  'api-keys': 'security',
  'oauth-applications': 'security',
  'connected-apps': 'security',
  'store-items': 'security',
};

export function slugifyAnchor(title: string) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function readSettingAnchor({ search, hash }: { search: string; hash: string }) {
  const raw = new URLSearchParams(search).get(SETTING_PARAM) ?? hash.replace(/^#/, '');
  try {
    return decodeURIComponent(raw).trim().toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

export function getSettingHref(anchor: string) {
  return `/user/account?${SETTING_PARAM}=${encodeURIComponent(anchor)}`;
}

/** Returns nothing when already on the anchor's pane, so the re-run after `router.replace` does not loop. */
export function resolveSettingRedirect(location: {
  pathname: string;
  search: string;
  hash: string;
}) {
  const anchor = readSettingAnchor(location);
  const paneId = anchor ? settingPanes[anchor] : undefined;
  const section = paneId ? accountSections.find((s) => s.id === paneId) : undefined;
  if (!section) return undefined;

  const target = getAccountSectionHref(section);
  if (location.pathname === target) return undefined;
  return {
    pathname: target,
    query: Object.fromEntries(new URLSearchParams(location.search).entries()),
    hash: location.hash.replace(/^#/, ''),
  };
}
