/**
 * Token Scope — Bitwise flags for API key and OAuth token permissions.
 *
 * SHARED across the main app (API-key UI + scope validation) and the hub (OAuth consent + scope
 * validation), so it lives in @civitai/auth. Pure constants — no env, no node, client-safe. The main
 * app re-exports this from `~/shared/constants/token-scope.constants` so existing call sites are unchanged.
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

  // App Blocks — submit an App Block bundle/version for moderator review.
  // Opt-in, off-by-default (NOT part of `Full`): granted only to OAuth clients
  // that explicitly list it in `allowedScopes` and request it (e.g. the
  // first-party `civitai-cli` client). The submit endpoint
  // (api/v1/blocks/submit-version) accepts an OAuth-issued token ONLY if it
  // carries this bit AND the user is a moderator. See AppBlocksSubmit gate.
  AppBlocksSubmit: 1 << 25, // 33554432

  // App Blocks — open an on-site dev tunnel for an App Block you author.
  // Opt-in, off-by-default (NOT part of `Full`): granted only to OAuth clients
  // that explicitly list it in `allowedScopes` and request it (currently only
  // the first-party `civitai-cli` client, so `civitai app dev-tunnel` works over
  // the OAuth `civitai login` token instead of a Full personal API key). The
  // dev-tunnel tRPC procedures (blocks.router: startDevTunnel / stopDevTunnel /
  // devTunnelStatus) gate on this bit via `.meta({ requiredScope })`. Like
  // AppBlocksSubmit it is EXCLUDED from `Full` so it never widens an existing key.
  AppBlocksDevTunnel: 1 << 26, // 67108864

  // All scopes
  //
  // NOTE: `Full` is INTENTIONALLY frozen at (1 << 25) - 1 = 33554431 — it is the
  // OR of bits 0..24 ONLY and deliberately EXCLUDES `AppBlocksSubmit` (bit 25).
  // Existing personal API keys persist `tokenScope = 33554431` in the DB; changing
  // this constant would silently re-interpret every stored key. `AppBlocksSubmit`
  // is an opt-in capability, never folded into "Full Access". To bound a value
  // against every DEFINED bit (incl. AppBlocksSubmit), use `ALL_SCOPES` below, not
  // `Full`.
  Full: (1 << 25) - 1, // 33554431
} as const;

export type TokenScopeValue = (typeof TokenScope)[keyof typeof TokenScope];

/**
 * Mask of EVERY defined scope bit, including opt-in scopes that are NOT part of
 * `Full` (currently `AppBlocksSubmit` and `AppBlocksDevTunnel`). Use this as the upper bound when
 * validating a requested/stored scope value in the OAuth flow — bounding against
 * `Full` would reject any value carrying an opt-in bit. Computed from the enum so
 * it can never drift behind a newly-added bit.
 */
export const ALL_SCOPES: number = Object.entries(TokenScope)
  .filter(([key]) => key !== 'None' && key !== 'Full')
  .reduce((acc, [, value]) => acc | value, 0);

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
  [TokenScope.AppBlocksSubmit]: 'Submit Apps for review',
  [TokenScope.AppBlocksDevTunnel]: 'Open on-site dev tunnels',
};

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
} as const;

/** Preset labels for the dropdown */
export const tokenScopePresetLabels: Record<keyof typeof TokenScopePresets, string> = {
  ReadOnly: 'Read Only',
  Creator: 'Creator',
  AIServices: 'AI Services',
  Full: 'Full Access',
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
