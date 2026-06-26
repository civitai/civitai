import { TokenScope, TokenScopePresets } from '~/shared/constants/token-scope.constants';

export type ApiKeyDeeplinkPrefill = { name: string; tokenScope: number };

/** Structural shape of Next's `router.query` (a ParsedUrlQuery) — avoids a `querystring` import. */
type RouterQuery = Record<string, string | string[] | undefined>;

/** The query keys the API-key deeplink consumes; stripped from the URL after handling. */
export const API_KEY_DEEPLINK_PARAMS = ['addApiKey', 'name', 'scope'] as const;

/**
 * Parse the "create an API key" deeplink query into a modal prefill, or `null`
 * when the trigger (`addApiKey`) is absent. Used so an external link (e.g. the
 * App Blocks CLI scaffold's dev:live setup card) can open the Add-API-Key modal
 * pre-filled with a name and the minimal scope.
 *
 * Security: this only PREFILLS the modal — the user still reviews the name +
 * scope and clicks Generate, so a crafted link can never silently mint a key.
 *
 * - `name`: prefilled key name (empty when absent or array-valued).
 * - `scope`: a TokenScopePresets KEY (e.g. `AIServices`). An unknown/absent/
 *   array value falls back to `Full` — the modal's normal manual default — never
 *   an invalid bitmask.
 */
export function parseApiKeyDeeplink(query: RouterQuery): ApiKeyDeeplinkPrefill | null {
  if (query.addApiKey == null) return null;
  const name = typeof query.name === 'string' ? query.name : '';
  const scopeKey = typeof query.scope === 'string' ? query.scope : '';
  const presetScope = (TokenScopePresets as Record<string, number>)[scopeKey];
  return { name, tokenScope: presetScope ?? TokenScope.Full };
}
