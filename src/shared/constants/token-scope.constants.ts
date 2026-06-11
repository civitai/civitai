/**
 * Token Scope — Bitwise flags for API key and OAuth token permissions.
 *
 * Each scope is a power of 2 so they can be combined with bitwise OR.
 * Use `Flags.hasFlag(tokenScope, TokenScope.ModelsWrite)` to check.
 *
 * Buzz spending is implicit in the scopes that require it:
 *  - AIServicesWrite (generation, training, scanning)
 *  - BountiesWrite (bounty creation)
 *  - SocialTip (tipping)
 */
export const TokenScope = {
  None: 0,

  // Account & Profile
  UserRead: 1 << 0, // 1
  UserWrite: 1 << 1, // 2

  // Models & Resources
  ModelsRead: 1 << 2, // 4
  ModelsWrite: 1 << 3, // 8
  ModelsDelete: 1 << 4, // 16

  // Media & Posts (images, videos, posts)
  MediaRead: 1 << 5, // 32
  MediaWrite: 1 << 6, // 64
  MediaDelete: 1 << 7, // 128

  // Articles
  ArticlesRead: 1 << 8, // 256
  ArticlesWrite: 1 << 9, // 512
  ArticlesDelete: 1 << 10, // 1024

  // Bounties (write implicitly allows buzz spend for bounty creation)
  BountiesRead: 1 << 11, // 2048
  BountiesWrite: 1 << 12, // 4096
  BountiesDelete: 1 << 13, // 8192

  // AI Services — generation, training, scanning, all orchestrator requests
  // Write implicitly allows buzz spend for orchestrator usage
  AIServicesRead: 1 << 14, // 16384
  AIServicesWrite: 1 << 15, // 32768

  // Buzz (Currency)
  BuzzRead: 1 << 16, // 65536

  // Collections & Interactions
  CollectionsRead: 1 << 17, // 131072
  CollectionsWrite: 1 << 18, // 262144
  SocialWrite: 1 << 19, // 524288 — follow, react, comment, review
  SocialTip: 1 << 20, // 1048576 — tip other users (buzz spend)

  // Notifications
  NotificationsRead: 1 << 21, // 2097152
  NotificationsWrite: 1 << 22, // 4194304

  // Vault
  VaultRead: 1 << 23, // 8388608
  VaultWrite: 1 << 24, // 16777216

  // All scopes
  Full: (1 << 25) - 1, // 33554431
} as const;

export type TokenScopeValue = (typeof TokenScope)[keyof typeof TokenScope];

/** Human-readable labels for each scope, used in UI */
export const tokenScopeLabels: Record<number, string> = {
  [TokenScope.UserRead]: 'Read profile, settings & email',
  [TokenScope.UserWrite]: 'Update profile & settings',
  [TokenScope.ModelsRead]: 'Browse & download models',
  [TokenScope.ModelsWrite]: 'Upload & edit models',
  [TokenScope.ModelsDelete]: 'Delete models',
  [TokenScope.MediaRead]: 'View images, videos & posts',
  [TokenScope.MediaWrite]: 'Upload media & create posts',
  [TokenScope.MediaDelete]: 'Delete media & posts',
  [TokenScope.ArticlesRead]: 'Read articles',
  [TokenScope.ArticlesWrite]: 'Create & edit articles',
  [TokenScope.ArticlesDelete]: 'Delete articles',
  [TokenScope.BountiesRead]: 'View bounties',
  [TokenScope.BountiesWrite]: 'Create & manage bounties',
  [TokenScope.BountiesDelete]: 'Delete bounties',
  [TokenScope.AIServicesRead]: 'View generation & training history',
  [TokenScope.AIServicesWrite]: 'Generate, train & scan',
  [TokenScope.BuzzRead]: 'View buzz balance & history',
  [TokenScope.CollectionsRead]: 'View collections',
  [TokenScope.CollectionsWrite]: 'Manage collections',
  [TokenScope.SocialWrite]: 'Follow, react, comment & review',
  [TokenScope.SocialTip]: 'Tip other users',
  [TokenScope.NotificationsRead]: 'Read notifications',
  [TokenScope.NotificationsWrite]: 'Manage notification preferences',
  [TokenScope.VaultRead]: 'View vault',
  [TokenScope.VaultWrite]: 'Manage vault',
};

/**
 * Canonical scope NAMES (RFC 6749 / OAuth space-delimited scope strings).
 *
 * This map is the SOURCE OF TRUTH for the wire-format scope names exposed in
 * discovery metadata (`scopes_supported`) and accepted by Dynamic Client
 * Registration (RFC 7591). The MCP server's advertised scope metadata MUST
 * match these names exactly. `full` maps to the all-bits mask but is never
 * granted to dynamically-registered (DCR) clients.
 */
export const tokenScopeNameToFlag: Record<string, number> = {
  'user:read': TokenScope.UserRead,
  'user:write': TokenScope.UserWrite,
  'models:read': TokenScope.ModelsRead,
  'models:write': TokenScope.ModelsWrite,
  'models:delete': TokenScope.ModelsDelete,
  'media:read': TokenScope.MediaRead,
  'media:write': TokenScope.MediaWrite,
  'media:delete': TokenScope.MediaDelete,
  'articles:read': TokenScope.ArticlesRead,
  'articles:write': TokenScope.ArticlesWrite,
  'articles:delete': TokenScope.ArticlesDelete,
  'bounties:read': TokenScope.BountiesRead,
  'bounties:write': TokenScope.BountiesWrite,
  'bounties:delete': TokenScope.BountiesDelete,
  'ai:read': TokenScope.AIServicesRead,
  'ai:write': TokenScope.AIServicesWrite,
  'buzz:read': TokenScope.BuzzRead,
  'collections:read': TokenScope.CollectionsRead,
  'collections:write': TokenScope.CollectionsWrite,
  'social:write': TokenScope.SocialWrite,
  'social:tip': TokenScope.SocialTip,
  'notifications:read': TokenScope.NotificationsRead,
  'notifications:write': TokenScope.NotificationsWrite,
  'vault:read': TokenScope.VaultRead,
  'vault:write': TokenScope.VaultWrite,
  full: TokenScope.Full,
};

/** Reverse map (single-bit flag -> canonical name). `full` is excluded so a
 * full mask decomposes into its individual scope names rather than collapsing
 * to the umbrella name. */
const tokenFlagToScopeName: Record<number, string> = Object.fromEntries(
  Object.entries(tokenScopeNameToFlag)
    .filter(([name]) => name !== 'full')
    .map(([name, flag]) => [flag, name])
);

/**
 * Convert an array of canonical scope names into a combined bitmask.
 * Unknown names are ignored (caller is responsible for rejecting them if the
 * contract requires it — e.g. the registration endpoint).
 */
export function scopeNamesToBitmask(names: string[]): number {
  let mask = 0;
  for (const name of names) {
    const flag = tokenScopeNameToFlag[name];
    if (flag != null) mask |= flag;
  }
  return mask;
}

/**
 * Convert a scope bitmask into the array of canonical scope names it contains,
 * in the enum's declared order. Never emits `full`.
 */
export function bitmaskToScopeNames(mask: number): string[] {
  const names: string[] = [];
  for (const [flagStr, name] of Object.entries(tokenFlagToScopeName)) {
    const flag = Number(flagStr);
    if ((mask & flag) === flag && flag !== 0) names.push(name);
  }
  return names;
}

/** Convenience presets for the API key creation UI */
export const TokenScopePresets = {
  ReadOnly:
    TokenScope.UserRead |
    TokenScope.ModelsRead |
    TokenScope.MediaRead |
    TokenScope.ArticlesRead |
    TokenScope.BountiesRead |
    TokenScope.BuzzRead |
    TokenScope.CollectionsRead |
    TokenScope.AIServicesRead |
    TokenScope.NotificationsRead |
    TokenScope.VaultRead,
  Creator:
    TokenScope.UserRead |
    TokenScope.ModelsRead |
    TokenScope.MediaRead |
    TokenScope.ArticlesRead |
    TokenScope.BountiesRead |
    TokenScope.BuzzRead |
    TokenScope.CollectionsRead |
    TokenScope.AIServicesRead |
    TokenScope.NotificationsRead |
    TokenScope.VaultRead |
    TokenScope.ModelsWrite |
    TokenScope.MediaWrite |
    TokenScope.ArticlesWrite |
    TokenScope.BountiesWrite |
    TokenScope.CollectionsWrite |
    TokenScope.SocialWrite,
  AIServices:
    TokenScope.UserRead |
    TokenScope.AIServicesWrite |
    TokenScope.AIServicesRead |
    TokenScope.BuzzRead,
  Full: TokenScope.Full,

  /**
   * Maximum scope mask a Dynamically-Registered (RFC 7591) client may ever be
   * granted. This is the hard cap enforced at /register: even if the client
   * later requests more at /authorize, `validateScope` clamps to the client's
   * stored `allowedScopes`, which can never exceed this mask.
   *
   * EXCLUDED by policy (never available to DCR clients):
   *  - All Delete scopes (Models/Media/Articles/Bounties)
   *  - SocialTip (buzz spend)
   *  - AIServicesWrite (buzz spend — generation/training/scanning)
   *  - BountiesWrite (buzz spend — bounty creation)
   */
  MCPMaxAllowed:
    TokenScope.UserRead |
    TokenScope.ModelsRead |
    TokenScope.MediaRead |
    TokenScope.ArticlesRead |
    TokenScope.BountiesRead |
    TokenScope.BuzzRead |
    TokenScope.CollectionsRead |
    TokenScope.AIServicesRead |
    TokenScope.NotificationsRead |
    TokenScope.VaultRead |
    TokenScope.MediaWrite |
    TokenScope.ArticlesWrite |
    TokenScope.CollectionsWrite |
    TokenScope.SocialWrite |
    TokenScope.NotificationsWrite |
    TokenScope.ModelsWrite,

  /**
   * The scope set a freshly-registered MCP client is expected to request by
   * default (read everything it can + the safe writes). Used for the consent
   * pre-check / display default.
   */
  MCPDefault:
    TokenScope.UserRead |
    TokenScope.ModelsRead |
    TokenScope.MediaRead |
    TokenScope.ArticlesRead |
    TokenScope.BountiesRead |
    TokenScope.BuzzRead |
    TokenScope.CollectionsRead |
    TokenScope.AIServicesRead |
    TokenScope.NotificationsRead |
    TokenScope.VaultRead |
    TokenScope.MediaWrite |
    TokenScope.SocialWrite,
} as const;

/** Preset labels for the dropdown */
export const tokenScopePresetLabels: Record<keyof typeof TokenScopePresets, string> = {
  ReadOnly: 'Read Only',
  Creator: 'Creator',
  AIServices: 'AI Services',
  Full: 'Full Access',
  MCPMaxAllowed: 'MCP (Max Allowed)',
  MCPDefault: 'MCP (Default)',
};

/**
 * Scope grid for the permissions table UI.
 * Each row is a resource category with optional read/write/delete scope flags.
 */
export const tokenScopeGrid = [
  { label: 'Profile & Settings', read: TokenScope.UserRead, write: TokenScope.UserWrite },
  {
    label: 'Models',
    read: TokenScope.ModelsRead,
    write: TokenScope.ModelsWrite,
    delete: TokenScope.ModelsDelete,
  },
  {
    label: 'Media & Posts',
    read: TokenScope.MediaRead,
    write: TokenScope.MediaWrite,
    delete: TokenScope.MediaDelete,
  },
  {
    label: 'Articles',
    read: TokenScope.ArticlesRead,
    write: TokenScope.ArticlesWrite,
    delete: TokenScope.ArticlesDelete,
  },
  {
    label: 'Bounties',
    read: TokenScope.BountiesRead,
    write: TokenScope.BountiesWrite,
    delete: TokenScope.BountiesDelete,
  },
  { label: 'AI Services', read: TokenScope.AIServicesRead, write: TokenScope.AIServicesWrite },
  { label: 'Buzz', read: TokenScope.BuzzRead },
  { label: 'Collections', read: TokenScope.CollectionsRead, write: TokenScope.CollectionsWrite },
  { label: 'Social', write: TokenScope.SocialWrite },
  // SocialTip is intentionally hidden from the UI grid: tipping is a Civitai-side
  // buzz-spend op and `buzz.tipUser` is gated by `blockApiKeys: true`, so granting
  // the bit to a token would have no effect. The bit stays in the enum to keep
  // the bitmask stable for any keys that were issued before this hide.
  {
    label: 'Notifications',
    read: TokenScope.NotificationsRead,
    write: TokenScope.NotificationsWrite,
  },
  { label: 'Vault', read: TokenScope.VaultRead, write: TokenScope.VaultWrite },
] as const;

/** Get a human-readable label for a tokenScope bitmask */
export function getScopeLabel(tokenScope: number | null | undefined): string {
  if (tokenScope == null) return 'Legacy';
  if (tokenScope === TokenScope.Full) return 'Full Access';
  if (tokenScope === TokenScopePresets.ReadOnly) return 'Read Only';
  if (tokenScope === TokenScopePresets.Creator) return 'Creator';
  if (tokenScope === TokenScopePresets.AIServices) return 'AI Services';
  return 'Custom';
}
