/**
 * Token Scope — Bitwise flags for API key and OAuth token permissions.
 *
 * SHARED across the main app (API-key UI + scope validation) and the hub (OAuth consent + scope
 * validation), so it lives in @civitai/auth. Pure constants — no env, no node, client-safe. The main
 * app re-exports this from `~/shared/constants/token-scope.constants` so existing call sites are unchanged.
 *
 * Each scope is a power of 2 so they can be combined with bitwise OR. Scopes are `bigint`: bits 0..30
 * filled a 32-bit signed integer, and JS bitwise operators on a `number` are 32-bit, so a scope value
 * must never pass through a `number` `&`, `|`, `~` or shift. Use `hasScope(tokenScope,
 * TokenScope.ModelsWrite)` to check. At a wire or storage boundary that carries a JSON number, send
 * `Number(scope)` (every bit is below 2^53, so it is lossless) and read it back with
 * `parseTokenScope` (untrusted) or `BigInt` (storage).
 *
 * Buzz spending is implicit in the scopes that require it:
 *  - AIServicesWrite (generation, training, scanning)
 *  - BountiesWrite (bounty creation)
 *  - SocialTip (tipping)
 */
export const TokenScope = {
  None: 0n,

  // Account & Profile
  UserRead: 1n << 0n, // 1
  UserWrite: 1n << 1n, // 2

  // Models & Resources
  ModelsRead: 1n << 2n, // 4
  ModelsWrite: 1n << 3n, // 8
  ModelsDelete: 1n << 4n, // 16

  // Media & Posts (images, videos, posts)
  MediaRead: 1n << 5n, // 32
  MediaWrite: 1n << 6n, // 64
  MediaDelete: 1n << 7n, // 128

  // Articles
  ArticlesRead: 1n << 8n, // 256
  ArticlesWrite: 1n << 9n, // 512
  ArticlesDelete: 1n << 10n, // 1024

  // Bounties (write implicitly allows buzz spend for bounty creation)
  BountiesRead: 1n << 11n, // 2048
  BountiesWrite: 1n << 12n, // 4096
  BountiesDelete: 1n << 13n, // 8192

  // AI Services — generation, training, scanning, all orchestrator requests
  // Write implicitly allows buzz spend for orchestrator usage
  AIServicesRead: 1n << 14n, // 16384
  AIServicesWrite: 1n << 15n, // 32768

  // Buzz (Currency)
  BuzzRead: 1n << 16n, // 65536

  // Collections & Interactions
  CollectionsRead: 1n << 17n, // 131072
  CollectionsWrite: 1n << 18n, // 262144
  SocialWrite: 1n << 19n, // 524288 — follow, react, comment, review
  SocialTip: 1n << 20n, // 1048576 — tip other users (buzz spend)

  // Notifications
  NotificationsRead: 1n << 21n, // 2097152
  NotificationsWrite: 1n << 22n, // 4194304

  // Vault
  VaultRead: 1n << 23n, // 8388608
  VaultWrite: 1n << 24n, // 16777216

  // App Blocks — manage the Apps you author from a token: submit and withdraw versions, pull
  // source, mint local dev tokens, edit store listings, read analytics, and read and triage the
  // feedback inbox. The name is historical; submitting was the first thing it gated.
  // Opt-in, off-by-default (NOT part of `Full`): granted only to OAuth clients
  // that explicitly list it in `allowedScopes` and request it (e.g. the
  // first-party `civitai-cli` client). Keep its `tokenScopeLabels` entry in step with what it
  // gates: that label is the consent text.
  AppBlocksSubmit: 1n << 25n, // 33554432

  // App Blocks — open an on-site dev tunnel for an App Block you author.
  // Opt-in, off-by-default (NOT part of `Full`): granted only to OAuth clients
  // that explicitly list it in `allowedScopes` and request it (currently only
  // the first-party `civitai-cli` client, so `civitai app dev-tunnel` works over
  // the OAuth `civitai login` token instead of a Full personal API key). The
  // dev-tunnel tRPC procedures (blocks.router: startDevTunnel / stopDevTunnel /
  // devTunnelStatus / devTunnelDnsReady) gate on this bit via `.meta({ requiredScope })`. Like
  // AppBlocksSubmit it is EXCLUDED from `Full` so it never widens an existing key.
  AppBlocksDevTunnel: 1n << 26n, // 67108864

  // Civitai Link — pair the Civitai Link desktop app with this account. Opt-in and
  // EXCLUDED from `Full`: link-service introspects the app's access token and refuses
  // to mint an instance key without this bit.
  LinkConnect: 1n << 27n, // 134217728

  // App Store catalog sync — publish and withdraw store items under the off-site listing linked
  // to the calling OAuth client. Opt-in and EXCLUDED from `Full`, and only ever minted through
  // the `client_credentials` grant (see `CLIENT_CREDENTIALS_ONLY_SCOPES`); the hub refuses it on
  // every user-facing flow, the consent screen included.
  AppStoreCatalogWrite: 1n << 28n, // 268435456

  // Worker registration — a worker machine registering with the orchestrator. Opt-in and EXCLUDED
  // from `Full`, carried only by `Worker` tokens from the hub's token-exchange grant (see
  // `WORKER_ONLY_SCOPES`); every other grant refuses it.
  WorkerRegister: 1n << 29n, // 536870912

  // Download links — mint short, single-file download links on behalf of a named user
  // (`POST /api/v1/download-links`). Opt-in and EXCLUDED from `Full`, and only ever minted through
  // the `client_credentials` grant (see `CLIENT_CREDENTIALS_ONLY_SCOPES`).
  DownloadLink: 1n << 30n, // 1073741824

  // See the Apps available to you. Opt-in and EXCLUDED from `Full` (never widens an existing key);
  // a user scope, so an exchange resource may list it.
  AppsRead: 1n << 31n, // 2147483648

  // See your own data in Apps. Opt-in and EXCLUDED from `Full`; a user scope, so an exchange
  // resource may list it.
  AppDataRead: 1n << 32n, // 4294967296

  // Mint a recipe-runner block token for a user who granted the runner offline access. Opt-in,
  // EXCLUDED from `Full` and from `ALL_SCOPES`, and in `NON_USER_SCOPES`: no grant issues it and no
  // bearer route accepts it unless that path admits it by name (see `RUNNER_ONLY_SCOPES`).
  RunnerMint: 1n << 33n, // 8589934592

  // All scopes
  //
  // NOTE: `Full` is INTENTIONALLY frozen at (1n << 25n) - 1 = 33554431 — it is the
  // OR of bits 0..24 ONLY and deliberately EXCLUDES `AppBlocksSubmit` (bit 25).
  // Existing personal API keys persist `tokenScope = 33554431` in the DB; changing
  // this constant would silently re-interpret every stored key. `AppBlocksSubmit`
  // is an opt-in capability, never folded into "Full Access". To bound a value
  // against every DEFINED bit (incl. AppBlocksSubmit), use `ALL_SCOPES` below, not
  // `Full`.
  Full: (1n << 25n) - 1n, // 33554431
} as const;

export type TokenScopeValue = (typeof TokenScope)[keyof typeof TokenScope];

/**
 * Scopes only a recipe runner's token carries. Kept out of `ALL_SCOPES` and inside
 * `NON_USER_SCOPES`, so every scope parser and grant refuses them; a runner path admits them
 * explicitly. Never a system-app option, a consentable scope or an exchange resource.
 */
export const RUNNER_ONLY_SCOPES: bigint = TokenScope.RunnerMint;

/**
 * Mask of every defined scope bit a scope value may carry, including opt-in scopes that are NOT
 * part of `Full` (currently `AppBlocksSubmit`, `AppBlocksDevTunnel`, `LinkConnect`,
 * `AppStoreCatalogWrite`, `WorkerRegister`, `DownloadLink`, `AppsRead` and `AppDataRead`), and
 * excluding `RUNNER_ONLY_SCOPES`. Use this as the upper bound when validating a requested/stored
 * scope value in the OAuth flow — bounding against `Full` would reject any value carrying an
 * opt-in bit. Computed from the enum so it can never drift behind a newly-added bit.
 */
export const ALL_SCOPES: bigint =
  Object.entries(TokenScope)
    .filter(([key]) => key !== 'None' && key !== 'Full')
    .reduce((acc, [, value]) => acc | value, 0n) & ~RUNNER_ONLY_SCOPES;

/** Whether every bit of `flag` is set in `instance`. The bigint counterpart of `Flags.hasFlag`. */
export function hasScope(instance: bigint, flag: bigint): boolean {
  return (instance & flag) === flag;
}

/**
 * A scope from an untrusted wire value: a non-negative safe-integer number, a non-negative bigint, or
 * a decimal string. Null for anything else, or for a value with a bit outside `ALL_SCOPES`.
 */
export function parseTokenScope(raw: unknown): bigint | null {
  let value: bigint;
  if (typeof raw === 'bigint') value = raw;
  else if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) return null;
    value = BigInt(raw);
  } else if (typeof raw === 'string') {
    if (!/^\d{1,16}$/.test(raw)) return null;
    value = BigInt(raw);
  } else return null;
  if (value < 0n || (value & ~ALL_SCOPES) !== 0n) return null;
  return value;
}

// `ApiKey.tokenScope` is a 32-bit `integer`; `ApiKey.tokenScopeWide` is a nullable `bigint` added
// beside it. A writer fills both — the wide column with the whole scope, the old one with the bits
// it can hold — so a reader that knows only `tokenScope` (code from before the wide column) keeps
// working. A reader prefers the wide column and falls back to the old one for rows written before it.

/** The bits `ApiKey.tokenScope` (a signed 32-bit integer) can hold: 0..30. */
export const LEGACY_TOKEN_SCOPE_MASK: bigint = (1n << 31n) - 1n;

/** The two `ApiKey` columns a write of `scope` sets. */
export function apiKeyScopeColumns(scope: bigint): { tokenScope: number; tokenScopeWide: bigint } {
  return { tokenScope: Number(scope & LEGACY_TOKEN_SCOPE_MASK), tokenScopeWide: scope };
}

/** An `ApiKey` row's scope: `tokenScopeWide` when set, else `tokenScope`. */
export function readApiKeyScope(row: {
  tokenScope: bigint | number | string;
  tokenScopeWide?: bigint | number | string | null;
}): bigint {
  return BigInt(row.tokenScopeWide ?? row.tokenScope);
}

/** Each labelled scope bit with its human-readable label (the consent text), in bit order. */
const TOKEN_SCOPE_LABEL_ENTRIES: readonly (readonly [bigint, string])[] = [
  [TokenScope.UserRead, 'Read profile, settings & email'],
  [TokenScope.UserWrite, 'Update profile & settings'],
  [TokenScope.ModelsRead, 'Browse & download models'],
  [TokenScope.ModelsWrite, 'Upload & edit models'],
  [TokenScope.ModelsDelete, 'Delete models'],
  [TokenScope.MediaRead, 'View images, videos & posts'],
  [TokenScope.MediaWrite, 'Upload media & create posts'],
  [TokenScope.MediaDelete, 'Delete media & posts'],
  [TokenScope.ArticlesRead, 'Read articles'],
  [TokenScope.ArticlesWrite, 'Create & edit articles'],
  [TokenScope.ArticlesDelete, 'Delete articles'],
  [TokenScope.BountiesRead, 'View bounties'],
  [TokenScope.BountiesWrite, 'Create & manage bounties'],
  [TokenScope.BountiesDelete, 'Delete bounties'],
  [TokenScope.AIServicesRead, 'View generation & training history'],
  [TokenScope.AIServicesWrite, 'Generate, train & scan'],
  [TokenScope.BuzzRead, 'View buzz balance & history'],
  [TokenScope.CollectionsRead, 'View collections'],
  [TokenScope.CollectionsWrite, 'Manage collections'],
  [TokenScope.SocialWrite, 'Follow, react, comment & review'],
  [TokenScope.SocialTip, 'Tip other users'],
  [TokenScope.NotificationsRead, 'Read notifications'],
  [TokenScope.NotificationsWrite, 'Manage notification preferences'],
  [TokenScope.VaultRead, 'View vault'],
  [TokenScope.VaultWrite, 'Manage vault'],
  [
    TokenScope.AppBlocksSubmit,
    'Manage your Apps: submit versions, pull source, test locally, edit listings, view analytics and respond to user feedback',
  ],
  [TokenScope.AppBlocksDevTunnel, 'Open on-site dev tunnels'],
  [TokenScope.LinkConnect, 'Connect the Civitai Link app to your account'],
  [TokenScope.AppStoreCatalogWrite, "Publish items to the app's App Store listing"],
  [TokenScope.WorkerRegister, 'Register a worker machine with the orchestrator'],
  [TokenScope.DownloadLink, 'Create download links for generation jobs'],
  [TokenScope.AppsRead, 'See the Apps available to you'],
  [TokenScope.AppDataRead, 'See your own data in Apps'],
];

/**
 * Human-readable labels for each scope, used in UI, keyed by the bit's decimal string (an object key
 * cannot be a bigint). Read one with `tokenScopeLabel(bit)`.
 */
export const tokenScopeLabels: Readonly<Record<string, string>> = Object.fromEntries(
  TOKEN_SCOPE_LABEL_ENTRIES.map(([bit, label]) => [bit.toString(), label])
);

/** The label for a single scope bit, or undefined when the bit has none. */
export function tokenScopeLabel(bit: bigint): string | undefined {
  return tokenScopeLabels[bit.toString()];
}

/**
 * Scopes a token can carry only when minted through the `client_credentials` grant: the client
 * acting as itself, never on a user's behalf. Every other grant refuses them.
 */
export const CLIENT_CREDENTIALS_ONLY_SCOPES: bigint =
  TokenScope.AppStoreCatalogWrite | TokenScope.DownloadLink;

/** The most a `client_credentials` token may carry (`UserRead` is forced onto every token). */
export const CLIENT_CREDENTIALS_MAX_SCOPE: bigint =
  TokenScope.UserRead | TokenScope.AppStoreCatalogWrite | TokenScope.DownloadLink;

/** Scopes a token can carry only when minted through the hub's worker token-exchange grant. */
export const WORKER_ONLY_SCOPES: bigint = TokenScope.WorkerRegister;

/** Scopes no grant acting for a user may mint. */
export const NON_USER_SCOPES: bigint =
  CLIENT_CREDENTIALS_ONLY_SCOPES | WORKER_ONLY_SCOPES | RUNNER_ONLY_SCOPES;

/** The part of a client's `allowedScopes` a user can be asked to consent to. */
export function consentableScopes(allowedScopes: bigint): bigint {
  return allowedScopes & ~NON_USER_SCOPES;
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

/**
 * Get a human-readable label for a tokenScope bitmask. Takes a number too: a scope a tRPC response
 * carries arrives as one.
 */
export function getScopeLabel(scope: bigint | number | null | undefined): string {
  if (scope == null) return 'Legacy';
  const tokenScope = BigInt(scope);
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
const TOKEN_SCOPE_BITS: { bit: bigint; key: string }[] = Object.entries(TokenScope)
  .filter(([, value]) => value !== 0n && (value & (value - 1n)) === 0n) // power of two
  .map(([key, value]) => ({ bit: value, key }))
  .sort((a, b) => (a.bit < b.bit ? -1 : a.bit > b.bit ? 1 : 0));

/** bit → enum-key reverse lookup for the single-bit scopes. */
const BIT_TO_SCOPE_KEY: Map<bigint, string> = new Map(
  TOKEN_SCOPE_BITS.map(({ bit, key }) => [bit, key])
);

/** The enum-key (e.g. "ModelsRead") for a single scope bit, or undefined if the
 * value is not a defined single-bit scope. */
export function tokenScopeKeyByBit(bit: bigint): string | undefined {
  return BIT_TO_SCOPE_KEY.get(bit);
}

/**
 * Expand a tokenScope bitmask into the set of scopes it carries, each as
 * `{ bit, key, label }` (label from `tokenScopeLabels`, '' if none), sorted by
 * bit ascending. Mirrors `Flags.hasFlag(mask, bit)` with an inlined bit test so
 * this stays a dependency-free leaf module. Empty mask (0n) ⇒ [].
 */
export function tokenScopeMaskToList(mask: bigint): { bit: bigint; key: string; label: string }[] {
  return TOKEN_SCOPE_BITS.filter(({ bit }) => (mask & bit) === bit).map(({ bit, key }) => ({
    bit,
    key,
    label: tokenScopeLabel(bit) ?? '',
  }));
}

/**
 * True iff `requested` is a subset of the `allowedScopes` ceiling — i.e. carries
 * no bit outside it. `(requested & ~allowedScopes) === 0n`.
 */
export function connectScopesSubsetOfCeiling(requested: bigint, allowedScopes: bigint): boolean {
  return (requested & ~allowedScopes) === 0n;
}

/**
 * The reserved justification key for an OAuth-connect listing's OFFLINE-ACCESS declaration: the
 * OAuth scope name itself (`offline_access` asks for a refresh token, so the app can act while
 * the user is away). Present with a non-blank rationale ⇔ the listing declares it. It is never a
 * TokenScope key (those are PascalCase) and is not part of the requested-scope mask, because
 * offline access is a grant, not a bit.
 */
export const OFFLINE_ACCESS_JUSTIFICATION_KEY = 'offline_access';

/**
 * The ONE rule for whether a connect listing declares offline access, read from its stored
 * justification map (any JSON): the reserved key carries a non-blank string. Shared by the main app
 * (forms, approve gate, agent review) and the auth hub, so the two cannot disagree. The hub offers
 * offline access to a LISTED client (one with a listing that has been live) only while one of its
 * approved listings declares it.
 */
export function offlineAccessJustification(justifications: unknown): string | null {
  if (!justifications || typeof justifications !== 'object' || Array.isArray(justifications)) {
    return null;
  }
  const raw = (justifications as Record<string, unknown>)[OFFLINE_ACCESS_JUSTIFICATION_KEY];
  const text = typeof raw === 'string' ? raw.trim() : '';
  return text.length > 0 ? text : null;
}

/**
 * Validate an OAuth-connect listing's per-scope justifications against its
 * requested-scope mask. Returns an array of human-readable error strings (empty
 * ⇒ valid). Mirrors the App Blocks manifest justification loop
 * (`block-manifest-validator.service.ts`): every key OTHER THAN
 * {@link OFFLINE_ACCESS_JUSTIFICATION_KEY} must be a valid single-bit `TokenScope` enum-key
 * whose bit is set in `requestedScopes` (keys ⊆ requested), with a non-empty string value
 * ≤ SCOPE_JUSTIFICATION_MAX_LENGTH. An empty map (`{}`) is valid — this only CAPTURES the dev's
 * stated rationale, it does not verify it. Justifications for scopes NOT requested are rejected
 * so no dangling rationale reaches the mod.
 *
 * {@link OFFLINE_ACCESS_JUSTIFICATION_KEY} is the offline-access declaration, not a scope: it is
 * accepted whatever the mask, and its value must be NON-BLANK (whitespace alone is refused, the
 * same test {@link offlineAccessJustification} applies) and ≤ SCOPE_JUSTIFICATION_MAX_LENGTH.
 */
export function validateConnectScopeJustifications(
  requestedScopes: bigint,
  justifications: Record<string, string>
): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(justifications)) {
    if (key === OFFLINE_ACCESS_JUSTIFICATION_KEY) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        errors.push(`scopeJustifications["${key}"] must be a non-empty string`);
      } else if (value.length > SCOPE_JUSTIFICATION_MAX_LENGTH) {
        errors.push(
          `scopeJustifications["${key}"] must be ≤${SCOPE_JUSTIFICATION_MAX_LENGTH} chars`
        );
      }
      continue;
    }
    const bit = Object.hasOwn(TokenScope, key)
      ? TokenScope[key as keyof typeof TokenScope]
      : undefined;
    // Unknown key, or an aggregate/sentinel member (None/Full) that is not a
    // single justifiable scope.
    if (bit === undefined || bit === 0n || (bit & (bit - 1n)) !== 0n) {
      errors.push(`scopeJustifications references "${key}" which is not a valid scope`);
      continue;
    }
    if ((requestedScopes & bit) !== bit) {
      errors.push(`scopeJustifications["${key}"] is not among the requested scopes`);
      continue;
    }
    if (typeof value !== 'string' || value.length === 0) {
      errors.push(`scopeJustifications["${key}"] must be a non-empty string`);
    } else if (value.length > SCOPE_JUSTIFICATION_MAX_LENGTH) {
      errors.push(`scopeJustifications["${key}"] must be ≤${SCOPE_JUSTIFICATION_MAX_LENGTH} chars`);
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
 *  - private:    `UserRead` (profile, settings & EMAIL / PII) + the private-data
 *                reads `NotificationsRead` (a user's personal notifications),
 *                `VaultRead` (the user's PRIVATE model vault) and `AppDataRead` (the
 *                user's own data stored in Apps). Mirrors the App Blocks
 *                sensitivity principle where private-data reads (e.g.
 *                `collections:read:private`) are sensitive.
 *  - cross-user / destructive: every `*Write` + `*Delete` (they create, mutate or
 *                remove content others can see, or edit the user's own account).
 *
 * Written as an EXPLICIT named-bit OR (not a computed "everything but reads") so a
 * moderator can eyeball exactly which permissions are flagged, and adding a new
 * scope bit never silently folds it in. Deliberately EXCLUDES the read-only scopes
 * that expose only PUBLIC data (`ModelsRead`/`MediaRead`/`ArticlesRead`/
 * `BountiesRead`/`AIServicesRead`/`CollectionsRead`, and `AppsRead` — the Apps
 * catalog) and the opt-in scopes
 * (`AppBlocksSubmit`/`AppBlocksDevTunnel`/`LinkConnect`/`AppStoreCatalogWrite`, never part of a
 * connect ceiling).
 * `NotificationsWrite`/`VaultWrite` are included as account-mutating writes even
 * though they are self-scoped.
 */
export const SENSITIVE_TOKEN_SCOPES: bigint =
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
  TokenScope.NotificationsRead | // private: a user's personal notifications (mentions/alerts/transaction notices)
  TokenScope.NotificationsWrite |
  TokenScope.VaultRead | // private: the user's PRIVATE model vault (what private models they've stored)
  TokenScope.VaultWrite |
  TokenScope.AppDataRead; // private: the user's own data stored in Apps

/**
 * True iff `bit` carries ANY sensitive scope bit (see {@link SENSITIVE_TOKEN_SCOPES}).
 * Works for a single scope bit OR a multi-bit mask — a mask is sensitive when it
 * intersects the sensitive set at all.
 */
export function isSensitiveTokenScope(bit: bigint): boolean {
  return (bit & SENSITIVE_TOKEN_SCOPES) !== 0n;
}
