import type { Icon } from '@tabler/icons-react';
import {
  IconAdjustmentsHorizontal,
  IconBell,
  IconCreditCard,
  IconEye,
  IconLayoutDashboard,
  IconPalette,
  IconShieldLock,
  IconUser,
} from '@tabler/icons-react';

export const accountSectionGroups = [
  { id: 'account', label: 'Account' },
  { id: 'content', label: 'Content' },
  { id: 'access', label: 'Billing & access' },
] as const;

export type AccountSectionGroupId = (typeof accountSectionGroups)[number]['id'];

export type AccountSection = {
  id: string;
  /** URL segment under `/user/account`. Empty string is the index. */
  path: string;
  label: string;
  icon: Icon;
  group: AccountSectionGroupId;
  /**
   * What the search box matches on. Labels alone only ever find the section you already
   * know the name of, which is the case that needed no search.
   */
  keywords: string[];
};

export const accountSections: AccountSection[] = [
  {
    id: 'overview',
    path: '',
    label: 'Overview',
    icon: IconLayoutDashboard,
    group: 'account',
    keywords: ['membership', 'buzz', 'standing', 'email', 'summary'],
  },
  {
    id: 'profile',
    path: 'profile',
    label: 'Profile & Account',
    icon: IconUser,
    group: 'account',
    keywords: [
      'username',
      'email',
      'social links',
      'sponsorship',
      'creator score',
      'strikes',
      'standing',
      'delete account',
      'refresh session',
    ],
  },
  {
    id: 'preferences',
    path: 'preferences',
    label: 'Preferences',
    icon: IconAdjustmentsHorizontal,
    group: 'account',
    keywords: [
      'autoplay',
      'gifs',
      'image format',
      'model format',
      'precision',
      'quant',
      'assistant',
      'civbot',
      'chats',
      'blue buzz',
      'early adopter',
      'video controls',
      'advanced mode',
      'air',
    ],
  },
  {
    id: 'notifications',
    path: 'notifications',
    label: 'Notifications',
    icon: IconBell,
    group: 'account',
    keywords: ['email notifications', 'on-site', 'comments', 'milestones', 'buzz', 'moderation'],
  },
  {
    id: 'content',
    path: 'content',
    label: 'Content & Browsing',
    icon: IconEye,
    group: 'content',
    keywords: ['mature', 'nsfw', 'browsing level', 'blur', 'hidden tags', 'hidden users'],
  },
  {
    id: 'creator',
    path: 'creator',
    label: 'Creator',
    icon: IconPalette,
    group: 'content',
    keywords: [
      'stickers',
      'placement',
      'remix gallery',
      'donation goals',
      'download count',
      'generation count',
      'earned buzz',
    ],
  },
  {
    id: 'billing',
    path: 'billing',
    label: 'Membership & Billing',
    icon: IconCreditCard,
    group: 'access',
    keywords: [
      'subscription',
      'membership',
      'payment methods',
      'cards',
      'payouts',
      'stripe',
      'tipalti',
      'gift',
    ],
  },
  {
    id: 'security',
    path: 'security',
    label: 'Security & Apps',
    icon: IconShieldLock,
    group: 'access',
    keywords: ['sign in', 'connected accounts', 'api keys', 'oauth', 'connected apps'],
  },
];

export function searchAccountSections(query: string) {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return accountSections;
  return accountSections.filter(
    (section) =>
      section.label.toLowerCase().includes(trimmed) ||
      section.keywords.some((keyword) => keyword.includes(trimmed))
  );
}

export const defaultAccountSection = accountSections[0];

export function getAccountSectionHref(section: AccountSection) {
  return section.path ? `/user/account/${section.path}` : '/user/account';
}

export function resolveAccountSection(path: string | undefined) {
  if (!path) return defaultAccountSection;
  return accountSections.find((section) => section.path === path);
}

/**
 * Anchors that already point into this page from places we cannot edit — Stripe and Tipalti
 * `return_url`s stored provider-side, and strike emails already delivered. A fragment never
 * reaches the server, so these cannot be handled by a `next.config` redirect; the shell maps
 * them on mount instead. Removing an entry silently strands whatever still emits it.
 */
export const legacyAnchorSections: Record<string, string> = {
  accounts: 'security',
  'api-keys': 'security',
  'creator-score': 'profile',
  'manage-subscription': 'billing',
  'notification-settings': 'notifications',
  'payment-methods': 'billing',
  payments: 'billing',
  strikes: 'profile',
};

export function resolveLegacyAnchor(hash: string) {
  const key = hash.replace(/^#/, '').toLowerCase();
  const sectionId = legacyAnchorSections[key];
  if (!sectionId) return undefined;
  return accountSections.find((section) => section.id === sectionId);
}
