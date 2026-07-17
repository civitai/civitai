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
 * `Full` (currently `AppBlocksSubmit` and `AppBlocksDevTunnel`). Use this as the
 * upper bound when validating a requested/stored scope value in the OAuth flow —
 * bounding against `Full` would reject any value carrying an opt-in bit. Computed
 * from the enum so it can never drift behind a newly-added bit.
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

// ---------------------------------------------------------------------------
// OAuth-connect scope review (W13) — shared, pure helpers + validator.
//
// Dark groundwork: nothing references these at runtime yet. They back the
// per-scope justification/review that the OAuth-connect app-listing authoring
// (PR2) and mod-review (PR3) flows will use. Kept here — next to the scope
// vocab — so the bitmask, the justification-key mapping, and the length bound
// have a SINGLE source of truth. Still env/DOM-free and client-safe.
// ---------------------------------------------------------------------------

/**
 * Max length of a single per-scope justification string. SINGLE SOURCE — the
 * App Blocks manifest validator (`block-manifest-validator.service.ts`) and the
 * OAuth-connect validator below both import this so the bound can never drift.
 * Also mirrors the published App Block manifest schema's
 * `scopeJustifications.additionalProperties.maxLength`.
 */
export const SCOPE_JUSTIFICATION_MAX_LENGTH = 500;

/**
 * Every SINGLE-BIT scope in the enum, as `{ bit, key }`, sorted by bit ascending.
 * Excludes the aggregate/sentinel members `None` (0) and `Full` (an OR of many
 * bits) via the power-of-two test — so it can never accidentally list a
 * composite value, and never drifts behind a newly-added bit.
 */
const TOKEN_SCOPE_BITS: { bit: number; key: string }[] = Object.entries(TokenScope)
  .filter(([, value]) => value !== 0 && (value & (value - 1)) === 0) // power of two
  .map(([key, value]) => ({ bit: value as number, key }))
  .sort((a, b) => a.bit - b.bit);

/** bit → enum-key reverse lookup for the single-bit scopes. */
const BIT_TO_SCOPE_KEY: Map<number, string> = new Map(
  TOKEN_SCOPE_BITS.map(({ bit, key }) => [bit, key])
);

/** The enum-key (e.g. "ModelsRead") for a single scope bit, or undefined if the
 * value is not a defined single-bit scope. */
export function tokenScopeKeyByBit(bit: number): string | undefined {
  return BIT_TO_SCOPE_KEY.get(bit);
}

/**
 * Expand a tokenScope bitmask into the set of scopes it carries, each as
 * `{ bit, key, label }` (label from `tokenScopeLabels`, '' if none), sorted by
 * bit ascending. Mirrors `Flags.hasFlag(mask, bit)` with an inlined bit test so
 * this stays a dependency-free leaf module. Empty mask (0) ⇒ [].
 */
export function tokenScopeMaskToList(
  mask: number
): { bit: number; key: string; label: string }[] {
  return TOKEN_SCOPE_BITS.filter(({ bit }) => (mask & bit) === bit).map(({ bit, key }) => ({
    bit,
    key,
    label: tokenScopeLabels[bit] ?? '',
  }));
}

/**
 * True iff `requested` is a subset of the `allowedScopes` ceiling — i.e. carries
 * no bit outside it. `(requested & ~allowedScopes) === 0`.
 */
export function connectScopesSubsetOfCeiling(requested: number, allowedScopes: number): boolean {
  return (requested & ~allowedScopes) === 0;
}

/**
 * Validate an OAuth-connect listing's per-scope justifications against its
 * requested-scope mask. Returns an array of human-readable error strings (empty
 * ⇒ valid). Mirrors the App Blocks manifest justification loop
 * (`block-manifest-validator.service.ts`): every key must be a valid single-bit
 * `TokenScope` enum-key, every key's bit must be set in `requestedScopes` (keys
 * ⊆ requested), and every value must be a non-empty string
 * ≤ SCOPE_JUSTIFICATION_MAX_LENGTH. An empty map (`{}`) is valid — this only
 * CAPTURES the dev's stated rationale, it does not verify it. Justifications for
 * scopes NOT requested are rejected so no dangling rationale reaches the mod.
 */
export function validateConnectScopeJustifications(
  requestedScopes: number,
  justifications: Record<string, string>
): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(justifications)) {
    const bit = (TokenScope as Record<string, number>)[key];
    // Unknown key, or an aggregate/sentinel member (None/Full) that is not a
    // single justifiable scope.
    if (bit === undefined || bit === 0 || (bit & (bit - 1)) !== 0) {
      errors.push(`scopeJustifications references "${key}" which is not a valid scope`);
      continue;
    }
    if ((requestedScopes & bit) !== bit) {
      errors.push(
        `scopeJustifications["${key}"] is not among the requested scopes`
      );
      continue;
    }
    if (typeof value !== 'string' || value.length === 0) {
      errors.push(`scopeJustifications["${key}"] must be a non-empty string`);
    } else if (value.length > SCOPE_JUSTIFICATION_MAX_LENGTH) {
      errors.push(
        `scopeJustifications["${key}"] must be ≤${SCOPE_JUSTIFICATION_MAX_LENGTH} chars`
      );
    }
  }
  return errors;
}

/**
 * The SENSITIVE OAuth-scope taxonomy — the mask of scope bits a moderator must
 * scrutinise (and, for a connect listing, that MUST carry a per-scope
 * justification before approval; see `approveExternalRequest`).
 *
 * Principle — a scope is sensitive when granting it lets an app touch MONEY, read
 * PRIVATE/identity data, or WRITE data OTHER users see (cross-user side effects):
 *  - money:      `BuzzRead` (balance/history) + `SocialTip` (spend on tips) — and
 *                every `*Write` that implicitly spends Buzz (`AIServicesWrite`,
 *                `BountiesWrite`).
 *  - private:    `UserRead` (profile, settings & EMAIL / PII).
 *  - cross-user / destructive: every `*Write` + `*Delete` (they create, mutate or
 *                remove content others can see, or edit the user's own account).
 *
 * Written as an EXPLICIT named-bit OR (not a computed "everything but reads") so a
 * moderator can eyeball exactly which permissions are flagged, and adding a new
 * scope bit never silently folds it in. Deliberately EXCLUDES the read-only scopes
 * that expose only public data (`ModelsRead`/`MediaRead`/`ArticlesRead`/
 * `BountiesRead`/`AIServicesRead`/`CollectionsRead`/`NotificationsRead`/`VaultRead`)
 * and the opt-in App-Block scopes (`AppBlocksSubmit`/`AppBlocksDevTunnel`, never
 * part of a connect ceiling). `NotificationsWrite`/`VaultWrite` are included as
 * account-mutating writes even though they are self-scoped.
 */
export const SENSITIVE_TOKEN_SCOPES: number =
  TokenScope.UserRead | // private: profile, settings & email (PII)
  TokenScope.UserWrite | // mutates the account
  TokenScope.ModelsWrite |
  TokenScope.ModelsDelete |
  TokenScope.MediaWrite |
  TokenScope.MediaDelete |
  TokenScope.ArticlesWrite |
  TokenScope.ArticlesDelete |
  TokenScope.BountiesWrite | // buzz spend (bounty creation)
  TokenScope.BountiesDelete |
  TokenScope.AIServicesWrite | // buzz spend (generation/training)
  TokenScope.BuzzRead | // money: balance & history
  TokenScope.CollectionsWrite |
  TokenScope.SocialWrite | // cross-user: follow/react/comment/review
  TokenScope.SocialTip | // money: tip other users
  TokenScope.NotificationsWrite |
  TokenScope.VaultWrite;

/**
 * True iff `bit` carries ANY sensitive scope bit (see {@link SENSITIVE_TOKEN_SCOPES}).
 * Works for a single scope bit OR a multi-bit mask — a mask is sensitive when it
 * intersects the sensitive set at all.
 */
export function isSensitiveTokenScope(bit: number): boolean {
  return (bit & SENSITIVE_TOKEN_SCOPES) !== 0;
}
