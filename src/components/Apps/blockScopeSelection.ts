import {
  BLOCK_SCOPE_TO_OAUTH_BIT,
  isKnownBlockScope,
  isSensitiveBlockScope,
} from '~/shared/constants/block-scope.constants';
import { SCOPE_DESCRIPTIONS } from '~/server/services/blocks/scope-descriptions.constants';

/**
 * Pure state/derivation helpers for the App-manifest scope selector
 * (`BlockScopeSelector`). Extracted from the component so the selection logic is
 * unit-testable without a DOM: scope-option derivation, selection toggle, and the
 * justification linkage (deselecting a scope drops its justification from the
 * submitted payload).
 *
 * `SCOPE_DESCRIPTIONS` lives under `server/services/blocks/` but is a plain const
 * with no server-only imports and is ALREADY imported by client components
 * (`BlockScopeList.tsx`), so it is safe to bundle here — no server code is pulled
 * into the client graph.
 */

export type ScopeOption = {
  scope: string;
  /** Friendly description, or `null` when the scope has none (unknown/legacy). */
  description: string | null;
  /** Elevated-risk scope (see SENSITIVE_BLOCK_SCOPES) — drives the warning badge. */
  sensitive: boolean;
  /** Whether the scope is in the current registry. `false` = legacy/unknown. */
  known: boolean;
};

/** The selectable scope vocabulary — the keys of the OAuth-bit map (source of truth). */
export const KNOWN_BLOCK_SCOPES: string[] = Object.keys(BLOCK_SCOPE_TO_OAUTH_BIT);

/**
 * Build the checklist options for the given current selection. The known
 * registry is always listed (in declaration order); any SELECTED scope that is
 * NOT in the registry (a legacy/unknown scope carried by an existing manifest) is
 * appended so it renders as selected + removable rather than being silently
 * dropped.
 */
export function buildScopeOptions(selected: string[]): ScopeOption[] {
  const options: ScopeOption[] = KNOWN_BLOCK_SCOPES.map((scope) => ({
    scope,
    description: SCOPE_DESCRIPTIONS[scope] ?? null,
    sensitive: isSensitiveBlockScope(scope),
    known: true,
  }));
  const seenUnknown = new Set<string>();
  for (const scope of selected) {
    if (isKnownBlockScope(scope) || seenUnknown.has(scope)) continue;
    seenUnknown.add(scope);
    options.push({
      scope,
      description: SCOPE_DESCRIPTIONS[scope] ?? null,
      sensitive: isSensitiveBlockScope(scope),
      known: false,
    });
  }
  return options;
}

/**
 * Add or remove a scope from the current selection, preserving order and never
 * duplicating. Idempotent for a no-op toggle.
 */
export function toggleScope(selected: string[], scope: string, checked: boolean): string[] {
  if (checked) return selected.includes(scope) ? selected : [...selected, scope];
  return selected.filter((s) => s !== scope);
}

/**
 * Build the per-scope justification map to submit: only justifications for
 * CURRENTLY-SELECTED scopes, trimmed and non-empty. Deselecting a scope therefore
 * drops its justification from the payload (mirrors the server validator, which
 * rejects a justification for an undeclared scope).
 */
export function buildScopeJustifications(
  selected: string[],
  justifications: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const scope of selected) {
    const j = (justifications[scope] ?? '').trim();
    if (j.length > 0) out[scope] = j;
  }
  return out;
}
