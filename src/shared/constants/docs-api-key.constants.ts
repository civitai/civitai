import type { BuzzLimit } from '~/server/schema/api-key.schema';
import { readApiKeyScope, TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * The key the developer docs mint for their "Try it" panels (`/api/user/orchestrator-key`): a
 * personal key, listed in Settings, read access plus generation, a daily Buzz limit and an expiry.
 */
export const DOCS_API_KEY_NAME_PREFIX = 'Developer docs (';
export const docsApiKeyName = (host: string) => `${DOCS_API_KEY_NAME_PREFIX}${host})`;

export const DOCS_API_KEY_SCOPE =
  TokenScope.UserRead |
  TokenScope.ModelsRead |
  TokenScope.MediaRead |
  TokenScope.ArticlesRead |
  TokenScope.BountiesRead |
  TokenScope.CollectionsRead |
  TokenScope.VaultRead |
  TokenScope.AIServicesRead |
  TokenScope.AIServicesWrite;

export const DOCS_API_KEY_BUZZ_LIMIT: BuzzLimit = [
  { type: 'sliding', limit: 1000, window: 'day', unit: 1 },
];
export const DOCS_API_KEY_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
/** Live docs keys a user keeps per host; minting past it removes the oldest. */
export const DOCS_API_KEY_LIVE_CAP = 2;

/** Settings cannot create a key with this prefix, so only the docs route mints one. */
export const isReservedApiKeyName = (name: string) =>
  name.trim().toLowerCase().startsWith(DOCS_API_KEY_NAME_PREFIX.toLowerCase());

/**
 * Whether a row is a docs key. Every field must match, so a personal key that only shares the name
 * (one created before the prefix was reserved) is never removed or expired as one.
 */
export function isDocsApiKey(row: {
  name: string;
  type: string;
  expiresAt: Date | null;
  tokenScope: bigint | number | string;
  tokenScopeWide?: bigint | number | string | null;
}) {
  return (
    row.type === 'User' &&
    row.name.startsWith(DOCS_API_KEY_NAME_PREFIX) &&
    row.expiresAt !== null &&
    readApiKeyScope(row) === DOCS_API_KEY_SCOPE
  );
}
