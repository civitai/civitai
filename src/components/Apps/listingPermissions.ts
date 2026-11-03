import {
  SCOPE_DESCRIPTIONS,
  SCOPE_PLAIN_TITLES,
} from '~/server/services/blocks/scope-descriptions.constants';
import {
  BLOCK_SCOPE_TO_OAUTH_BIT,
  isSensitiveBlockScope,
} from '~/shared/constants/block-scope.constants';
import {
  isSensitiveTokenScope,
  TokenScope,
  tokenScopeLabels,
} from '~/shared/constants/token-scope.constants';

/**
 * The store detail page's permission list — ONE row model and ONE grouping/ordering rule for
 * both listing shapes (pure, React-free; rendered by `ListingPermissionsDisclosure`).
 *
 * 🔴 WHY THIS EXISTS: the page used to carry two renderers. An OFF-SITE connect listing's
 * `connectScopes` (TokenScope keys) went through a component that split them into a
 * "Sensitive permissions" group ahead of the rest and sorted each group by scope bit, while an
 * ON-SITE app's `scopes` (block scope ids) went through a flat card that printed them in stored
 * order — so one app page read grouped and the next read as an unsorted list. Both shapes now
 * become the same `ListingPermission` rows here and are grouped and ordered by
 * {@link groupListingPermissions}, so there is no second rule left to drift.
 *
 * The ORDER is the one the grouped renderer already used, not a new one: sensitive first, then
 * ascending OAuth scope bit. A block scope reaches that scale through the canonical
 * `BLOCK_SCOPE_TO_OAUTH_BIT` map; a block scope with no bit (`SKIP_OAUTH_CHECK` — storage,
 * collections, …) sorts after every bit-backed one in its group, in the order it was stored.
 */
export type ListingPermission = {
  /** The scope id (block scope) or TokenScope key (connect) — the row's identity, never shown. */
  id: string;
  /** The plain-language line a viewer reads. */
  title: string;
  /** Optional dimmed second line. */
  detail?: string;
  sensitive: boolean;
  /** Sort key within a group — the OAuth scope bit, or `Infinity` when the scope has none. */
  rank: number;
};

/**
 * On-site block scope ids → rows. A scope with no plain title falls back to its description,
 * then to the id, so a new scope is never silently dropped from the disclosure.
 */
export function blockScopePermissions(scopes: string[]): ListingPermission[] {
  return scopes.map((scope) => {
    const bit = BLOCK_SCOPE_TO_OAUTH_BIT[scope];
    return {
      id: scope,
      title: SCOPE_PLAIN_TITLES[scope] ?? SCOPE_DESCRIPTIONS[scope] ?? scope,
      detail: SCOPE_PLAIN_TITLES[scope] ? SCOPE_DESCRIPTIONS[scope] : undefined,
      sensitive: isSensitiveBlockScope(scope),
      rank: typeof bit === 'number' ? bit : Number.POSITIVE_INFINITY,
    };
  });
}

/**
 * Off-site connect TokenScope keys → rows. Resolved through the SHARED TokenScope table so the
 * label and the sensitivity verdict cannot fork from the OAuth consent screen. An unrecognised
 * key is DROPPED rather than rendered bare: a key this build does not know is a scope it cannot
 * describe, and an identifier with no label and no risk verdict is worse than silence on a
 * surface whose whole job is to inform.
 */
export function connectScopePermissions(keys: string[]): ListingPermission[] {
  const rows: ListingPermission[] = [];
  for (const key of keys) {
    const bit = TokenScope[key as keyof typeof TokenScope];
    if (typeof bit !== 'number' || bit <= 0) continue;
    rows.push({
      id: key,
      title: tokenScopeLabels[bit] || key,
      sensitive: isSensitiveTokenScope(bit),
      rank: bit,
    });
  }
  return rows;
}

/**
 * Split rows into the sensitive group and the rest, each ordered by `rank` ascending. The sort
 * is stable, so rows of equal rank (every bit-less block scope) keep their stored order.
 */
export function groupListingPermissions(permissions: ListingPermission[]): {
  sensitive: ListingPermission[];
  other: ListingPermission[];
} {
  const ordered = [...permissions].sort((a, b) =>
    a.rank === b.rank ? 0 : a.rank < b.rank ? -1 : 1
  );
  return {
    sensitive: ordered.filter((p) => p.sensitive),
    other: ordered.filter((p) => !p.sensitive),
  };
}
