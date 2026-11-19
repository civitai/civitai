import {
  apiKeyScopeColumns,
  CLIENT_CREDENTIALS_MAX_SCOPE,
  CLIENT_CREDENTIALS_ONLY_SCOPES,
  hasScope,
  NON_USER_SCOPES,
  parseTokenScope,
  readApiKeyScope,
  TokenScope,
  tokenScopeLabels,
} from '@civitai/auth/token-scope';

// Scope is a bitmask carried through @node-oauth/oauth2-server as a single-element string array (the
// library is string-scope oriented; we encode the bigint as its decimal string). These helpers are the
// ONLY place that conversion + the allowed-scope rule live.

/** Bitmask subset test — `flag`'s bits are all present in `instance`. */
export { hasScope };

/** Whether `requested` carries a scope only the `client_credentials` grant may mint. */
export function carriesClientCredentialsOnlyScope(requested: bigint): boolean {
  return (requested & CLIENT_CREDENTIALS_ONLY_SCOPES) !== 0n;
}

/** Whether `requested` carries a scope no grant acting for a user may mint. */
export function carriesNonUserScope(requested: bigint): boolean {
  return (requested & NON_USER_SCOPES) !== 0n;
}

// The scope columns are `bigint`: pg parses an `int8` to a number while the generated Kysely types
// call it a string, so a read goes through `scopeFromColumn` and a write through `scopeToColumn`. `ApiKey` keeps its 32-bit `tokenScope`
// beside the wide column: see `apiKeyScopeColumns` in @civitai/auth/token-scope.

/**
 * A scope column's value (a number from the pg driver, or the string Kysely's types name) as a bigint.
 * Throws on a non-integer, which the column never holds; a nullable column's caller handles null.
 */
export function scopeFromColumn(value: string | number | bigint): bigint {
  return BigInt(value);
}

/** A scope as a `bigint` column value. */
export function scopeToColumn(scope: bigint): string {
  return scope.toString();
}

/** The two `ApiKey` scope columns an insert of `scope` sets. */
export function apiKeyScopeInsert(scope: bigint): { tokenScope: number; tokenScopeWide: string } {
  const { tokenScope, tokenScopeWide } = apiKeyScopeColumns(scope);
  return { tokenScope, tokenScopeWide: scopeToColumn(tokenScopeWide) };
}

/** An `ApiKey` row's scope: `tokenScopeWide` when set, else `tokenScope`. */
export function apiKeyRowScope(row: {
  tokenScope: number | string | bigint;
  tokenScopeWide: number | string | bigint | null;
}): bigint {
  return readApiKeyScope(row);
}

/** `client_credentials` (the client acting as itself) or any grant that acts for a user. */
export type ScopeGrant = 'client_credentials' | 'user';

/**
 * Whether a token for `requested` may be minted for a client whose ceiling is `allowedScopes`,
 * through `grant`. The one rule every mint site applies: within the ceiling (`UserRead` always
 * allowed), and a `client_credentials`-only bit only through `client_credentials`, which in turn
 * can carry nothing beyond `CLIENT_CREDENTIALS_MAX_SCOPE`. Worker-only bits pass neither grant: the
 * worker token-exchange grant mints them itself.
 */
export function isScopeGrantable(
  allowedScopes: bigint,
  requested: bigint,
  grant: ScopeGrant
): boolean {
  if (!hasScope(allowedScopes | TokenScope.UserRead, requested)) return false;
  if (grant === 'client_credentials') return hasScope(CLIENT_CREDENTIALS_MAX_SCOPE, requested);
  return !carriesNonUserScope(requested);
}

/** Encode a scope bitmask as the library's string scope (single-element decimal-string array). */
export function scopeToString(scope: bigint): string[] {
  return [scope.toString()];
}

/** Decode the library's string scope back to a bitmask, clamping anything out of range to 0. */
export function stringToScope(scope: string | string[] | undefined): bigint {
  if (!scope) return 0n;
  const str = Array.isArray(scope) ? scope[0] : scope;
  // Bound against ALL_SCOPES (incl. opt-in bits like AppBlocksSubmit), NOT `Full` — clamping to `Full`
  // would silently drop an opt-in bit a client legitimately requested. Out-of-range → 0 (deny).
  return parseTokenScope(str) ?? 0n;
}

// OIDC's standard scopes (OIDC Core §5.4). `openid` is a request for an id_token, not a permission;
// `profile` and `email` are what UserRead already grants; refresh tokens are always issued, so
// `offline_access` adds nothing.
const OIDC_SCOPE_BITS: Record<string, bigint> = {
  profile: TokenScope.UserRead,
  email: TokenScope.UserRead,
  offline_access: TokenScope.None,
};

/** A `scope` request parameter, decoded: the permission bitmask, and whether it asked for `openid`. */
export interface ScopeRequest {
  scope: bigint;
  openid: boolean;
}

/**
 * Parse a `scope` request parameter (RFC 6749 §3.3: space-separated tokens). Each token is a
 * `TokenScope` name (`ModelsRead`), an OIDC scope (`openid`, `profile`, `email`, `offline_access`) or a
 * decimal bitmask (`5`, the original form, which a bare number still is). Tokens are ORed together.
 * Missing or blank is no permissions; the caller adds the UserRead baseline. Returns null for an
 * unknown token, a value outside ALL_SCOPES, or a non-string (a JSON body can carry an array or number).
 */
export function parseScopeRequest(raw: unknown): ScopeRequest | null {
  if (raw != null && typeof raw !== 'string') return null;
  let scope = 0n;
  let openid = false;
  for (const token of (raw ?? '').split(/\s+/).filter(Boolean)) {
    if (/^\d+$/.test(token)) {
      const value = parseTokenScope(token);
      if (value === null) return null;
      scope |= value;
    } else if (token === 'openid') {
      openid = true;
    } else if (Object.hasOwn(OIDC_SCOPE_BITS, token)) {
      scope |= OIDC_SCOPE_BITS[token];
    } else if (Object.hasOwn(TokenScope, token) && token !== 'None') {
      scope |= TokenScope[token as keyof typeof TokenScope];
    } else {
      return null;
    }
  }
  return { scope, openid };
}

/**
 * The scope names a `scope` parameter can obtain, for discovery's `scopes_supported`. It covers every
 * grant, so it includes AppStoreCatalogWrite (client_credentials only). WorkerRegister is left out: only
 * the worker token exchange mints it, never a `scope` request.
 */
export const SUPPORTED_SCOPE_NAMES: string[] = [
  'openid',
  ...Object.keys(OIDC_SCOPE_BITS),
  ...Object.keys(TokenScope).filter((name) => name !== 'None' && name !== 'WorkerRegister'),
];

/** Each labelled scope bit set in `scope`, with its label. */
export function scopeLabelEntries(scope: bigint): { bit: bigint; label: string }[] {
  return Object.entries(tokenScopeLabels)
    .map(([bit, label]) => ({ bit: BigInt(bit), label }))
    .filter(({ bit }) => hasScope(scope, bit));
}

/** Human-readable labels for the scope bits set in `scope` (shared by the consent + device-verify screens). */
export function scopeLabels(scope: bigint): string[] {
  return scopeLabelEntries(scope).map(({ label }) => label);
}
