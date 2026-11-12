import {
  SCOPE_DESCRIPTIONS,
  SCOPE_PLAIN_TITLES,
} from '~/server/services/blocks/scope-descriptions.constants';
import {
  BLOCK_SCOPE_TO_OAUTH_BIT,
  isConsentExemptScope,
  isSensitiveBlockScope,
} from '~/shared/constants/block-scope.constants';
import {
  isSensitiveTokenScope,
  TokenScope,
  tokenScopeLabels,
} from '~/shared/constants/token-scope.constants';
import { capitalize } from '~/utils/string-helpers';

/**
 * The store detail page's permission list — ONE row model and ONE grouping/ordering rule for
 * both listing shapes (pure, React-free; rendered by `ListingPermissionsDisclosure`).
 *
 * An OFF-SITE connect listing's `connectScopes` (TokenScope keys) and an ON-SITE app's `scopes`
 * (block scope ids) both become `ListingPermission` rows here and are grouped and ordered by
 * {@link groupListingPermissions}, so the two lists cannot drift apart.
 *
 * The ORDER: sensitive first, then
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

/** Appended to the description of every consent-exempt scope unless `noteIrrevocable` is off; see `permissionDetail`. */
export const IRREVOCABLE_PERMISSION_NOTE = "This permission can't be removed later.";

/**
 * On-site block scope ids → rows. A scope with no plain title falls back to its description,
 * then to a humanised form of the id, so a new scope is never silently dropped from the
 * disclosure and a viewer never reads a raw id.
 */
export function blockScopePermissions(
  scopes: string[],
  { noteIrrevocable = true }: { noteIrrevocable?: boolean } = {}
): ListingPermission[] {
  return scopes.map((scope) => {
    const bit = BLOCK_SCOPE_TO_OAUTH_BIT[scope];
    return {
      id: scope,
      title: SCOPE_PLAIN_TITLES[scope] ?? SCOPE_DESCRIPTIONS[scope] ?? humaniseScopeId(scope),
      detail: permissionDetail(scope, noteIrrevocable),
      sensitive: isSensitiveBlockScope(scope),
      rank: typeof bit === 'number' ? bit : Number.POSITIVE_INFINITY,
    };
  });
}

function permissionDetail(scope: string, noteIrrevocable: boolean): string | undefined {
  const description = SCOPE_PLAIN_TITLES[scope] ? SCOPE_DESCRIPTIONS[scope] : undefined;
  if (!noteIrrevocable || !isConsentExemptScope(scope)) return description;
  return description
    ? `${description.replace(/\.$/, '')}. ${IRREVOCABLE_PERMISSION_NOTE}`
    : IRREVOCABLE_PERMISSION_NOTE;
}

/** The plain-language name a viewer reads for one block scope. */
export function blockScopeTitle(scope: string): string {
  return blockScopePermissions([scope])[0].title;
}

/** `apps:storage:shared_write` → "Apps storage shared write". */
function humaniseScopeId(scope: string): string {
  return capitalize(
    scope
      .split(/[:_-]+/)
      .filter(Boolean)
      .join(' ')
  );
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

/**
 * {@link groupListingPermissions} for a list of block scope ids, returning the ids. For renderers
 * that draw their own rows (`BlockScopeList`, the moderator manifest review) but must group and
 * order exactly like the store listing. Every id comes back in exactly one group: a scope this
 * build does not know is not sensitive, so it lands last in `other`.
 */
export function groupBlockScopes(scopes: string[]): { sensitive: string[]; other: string[] } {
  const { sensitive, other } = groupListingPermissions(blockScopePermissions(scopes));
  return { sensitive: sensitive.map((p) => p.id), other: other.map((p) => p.id) };
}

export const PERMISSION_GROUP_LABELS = {
  sensitive: 'Sensitive permissions',
  other: 'Other permissions',
} as const;

export type PermissionGroup = {
  key: keyof typeof PERMISSION_GROUP_LABELS;
  label: string;
  scopes: string[];
};

/** {@link groupBlockScopes} as the ordered, non-empty groups a renderer draws, with labels. */
export function blockScopeGroups(scopes: string[]): PermissionGroup[] {
  const { sensitive, other } = groupBlockScopes(scopes);
  const groups: PermissionGroup[] = [
    { key: 'sensitive', label: PERMISSION_GROUP_LABELS.sensitive, scopes: sensitive },
    { key: 'other', label: PERMISSION_GROUP_LABELS.other, scopes: other },
  ];
  return groups.filter((g) => g.scopes.length > 0);
}
