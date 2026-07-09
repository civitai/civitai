import { TokenScopePresets } from '~/shared/constants/token-scope.constants';

export type ApiKeyDeeplinkPrefill = { name: string; tokenScope: number };

/** Structural shape of Next's `router.query` (a ParsedUrlQuery) — avoids a `querystring` import. */
type RouterQuery = Record<string, string | string[] | undefined>;

/** The query keys the API-key deeplink consumes; stripped from the URL after handling. */
export const API_KEY_DEEPLINK_PARAMS = ['addApiKey', 'name', 'scope'] as const;

/** Matches the Add-API-Key name input's maxLength (keep the prefill within UI bounds). */
const DEEPLINK_NAME_MAX = 64;

/**
 * Presets a deeplink is allowed to pre-select. `Full` is intentionally EXCLUDED:
 * a URL (which an attacker can craft and send to a logged-in user) must never
 * pre-select the broadest grant. An unknown/absent/array/`Full` scope falls back
 * to the least-privilege preset (`ReadOnly`), which the user can still raise in
 * the dialog. The sanctioned scaffold link sends `scope=AIServices`, which is in
 * this set, so the real flow is unaffected.
 */
const DEEPLINKABLE_PRESETS: ReadonlySet<string> = new Set(
  Object.keys(TokenScopePresets).filter((key) => key !== 'Full')
);

/**
 * Parse the "create an API key" deeplink query into a modal prefill, or `null`
 * when the trigger (`addApiKey`) is absent. Used so an external link (e.g. the
 * App Blocks CLI scaffold's dev:live setup card) can open the Add-API-Key modal
 * pre-filled with a name and the minimal scope.
 *
 * Security: this only PREFILLS the modal — the user still reviews the name +
 * scope and clicks Generate, so a crafted link can never silently mint a key.
 * Defense in depth: the scope can only ever pre-select a non-`Full` preset (see
 * {@link DEEPLINKABLE_PRESETS}), and the name is trimmed + length-clamped so a
 * URL can't seed an over-long value past the input's maxLength.
 *
 * - `name`: prefilled key name, trimmed + clamped to {@link DEEPLINK_NAME_MAX}
 *   (empty when absent or array-valued).
 * - `scope`: a TokenScopePresets KEY (e.g. `AIServices`). Unknown/absent/array/
 *   `Full` → `ReadOnly` (least privilege, never an invalid bitmask, never `Full`).
 */
export function parseApiKeyDeeplink(query: RouterQuery): ApiKeyDeeplinkPrefill | null {
  if (query.addApiKey == null) return null;
  const name =
    typeof query.name === 'string' ? query.name.trim().slice(0, DEEPLINK_NAME_MAX) : '';
  const scopeKey = typeof query.scope === 'string' ? query.scope : '';
  const tokenScope = DEEPLINKABLE_PRESETS.has(scopeKey)
    ? (TokenScopePresets as Record<string, number>)[scopeKey]
    : TokenScopePresets.ReadOnly;
  return { name, tokenScope };
}
