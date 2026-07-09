import { ALL_SCOPES, tokenScopeLabels } from '@civitai/auth/token-scope';

// Scope is a bitmask carried through @node-oauth/oauth2-server as a single-element string array (the
// library is string-scope oriented; we encode the number as its decimal string). These helpers are the
// ONLY place that conversion + the allowed-scope check live, ported 1:1 from the main app's model.ts so
// the hub and main app agree on exactly which bits a token carries.

/** Bitmask subset test — `flag`'s bits are all present in `instance`. Mirrors main-app `Flags.hasFlag`. */
export function hasScope(instance: number, flag: number): boolean {
  return (instance | flag) === instance;
}

/** Encode a scope bitmask as the library's string scope (single-element decimal-string array). */
export function scopeToString(scope: number): string[] {
  return [scope.toString()];
}

/** Decode the library's string scope back to a bitmask, clamping anything out of range to 0. */
export function stringToScope(scope: string | string[] | undefined): number {
  if (!scope) return 0;
  const str = Array.isArray(scope) ? scope[0] : scope;
  const parsed = parseInt(str, 10);
  // Bound against ALL_SCOPES (incl. opt-in bits like AppBlocksSubmit), NOT `Full` — clamping to `Full`
  // would silently drop an opt-in bit a client legitimately requested. Out-of-range → 0 (deny).
  if (isNaN(parsed) || parsed < 0 || parsed > ALL_SCOPES) return 0;
  return parsed;
}

/** Human-readable labels for the scope bits set in `scope` (shared by the consent + device-verify screens). */
export function scopeLabels(scope: number): string[] {
  return Object.entries(tokenScopeLabels)
    .filter(([bit]) => hasScope(scope, parseInt(bit, 10)))
    .map(([, label]) => label);
}
