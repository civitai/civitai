import { isFullScopeUserKey, type BearerCredential } from '~/server/auth/full-user-credential';
import { FLIPT_FEATURE_FLAGS, getFliptVariant } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { countBearerScopeRefused } from '~/server/prom/bearer-scope.metrics';
import { validateBlockScopesAgainstOauthClient } from '~/shared/constants/block-scope.constants';
import { hasScope, TokenScope } from '~/shared/constants/token-scope.constants';
import { ApiKeyType } from '~/shared/utils/prisma/enums';

export type BearerScopeMode = 'off' | 'log' | 'enforce';
export type BearerScopeRoute =
  | '/api/v1/blocks/submit-version'
  | '/api/v1/blocks/withdraw'
  | '/api/v1/blocks/submissions'
  | '/api/v1/blocks/dev-token'
  | 'download-link-mint'
  | 'download-link-fetch'
  | 'hub-token'
  | 'dev-tunnel-hub-token';

type Credential = BearerCredential & { apiKeyId?: number | null };

async function getBearerScopeMode(): Promise<BearerScopeMode> {
  const variant = await getFliptVariant(FLIPT_FEATURE_FLAGS.BEARER_SCOPE_TIGHTEN);
  return variant === 'log' || variant === 'enforce' ? variant : 'off';
}

/**
 * The `bearer-scope-tighten` mode for a credential found short of `scope` on `route`: `enforce`
 * means refuse it. Under `log` and `enforce` the shortfall is logged and counted.
 *
 * Only the flag decides: unlike the download routes' `scopeRefusalMode`, REST_SCOPE_ENFORCE does
 * not force these checks on.
 */
export async function bearerScopeMode(
  route: BearerScopeRoute,
  credential: Credential,
  scope: string | string[]
): Promise<BearerScopeMode> {
  const mode = await getBearerScopeMode().catch((): BearerScopeMode => 'off');
  if (mode === 'off') return mode;
  const credentialKind = credential.subject?.type ?? 'none';
  countBearerScopeRefused(route, credentialKind);
  // No token, user, email or address.
  logToAxiom({
    name: 'bearer-scope-refused',
    type: 'info',
    payload: {
      mode,
      route,
      scope,
      credentialKind,
      apiKeyType: credential.apiKeyType ?? null,
      tokenScope: credential.tokenScope == null ? null : Number(credential.tokenScope),
      apiKeyId: credential.apiKeyId ?? null,
      clientId: credential.subject?.type === 'oauth' ? String(credential.subject.id) : null,
    },
  });
  return mode;
}

export type AppBlocksCliCredentialCheck = 'ok' | 'oauth-refused' | 'key-refused';

/**
 * Whether a bearer credential may use an App Blocks CLI route: a full-scope personal key, or a
 * token carrying `AppBlocksSubmit`. An OAuth token without that bit is always refused; any other
 * key is refused only when `bearer-scope-tighten` enforces. `acceptAIServicesWrite` also accepts a
 * personal key holding `AIServicesWrite`, the preset the CLI's dev:live setup link creates.
 */
export async function checkAppBlocksCliCredential(
  route: BearerScopeRoute,
  credential: Credential,
  { acceptAIServicesWrite = false }: { acceptAIServicesWrite?: boolean } = {}
): Promise<AppBlocksCliCredentialCheck> {
  const scope = credential.tokenScope ?? 0n;
  if (isFullScopeUserKey(credential) || hasScope(scope, TokenScope.AppBlocksSubmit)) return 'ok';
  if (credential.subject?.type === 'oauth') return 'oauth-refused';
  if (
    acceptAIServicesWrite &&
    credential.apiKeyType === ApiKeyType.User &&
    hasScope(scope, TokenScope.AIServicesWrite)
  )
    return 'ok';
  const required = acceptAIServicesWrite
    ? ['Full', 'AppBlocksSubmit', 'AIServicesWrite']
    : ['Full', 'AppBlocksSubmit'];
  return (await bearerScopeMode(route, credential, required)) === 'enforce' ? 'key-refused' : 'ok';
}

/** The refusal message for a personal key `checkAppBlocksCliCredential` refused. */
export const APP_BLOCKS_CLI_KEY_REFUSED =
  'This needs a Full Access personal API key or an OAuth token with the Apps submit scope';

/**
 * `scopes` less the block scopes whose OAuth bit the credential lacks, when `bearer-scope-tighten`
 * enforces; unchanged otherwise. Scopes with no OAuth bit (storage, collections, reactions) are
 * kept: their gates are consent and per-operation checks.
 */
export async function narrowBlockScopesToCredential(
  route: BearerScopeRoute,
  credential: Credential,
  scopes: string[]
): Promise<string[]> {
  const rejected = validateBlockScopesAgainstOauthClient(
    scopes,
    credential.tokenScope ?? 0n
  ).rejectedScopes;
  if (rejected.length === 0) return scopes;
  if ((await bearerScopeMode(route, credential, rejected)) !== 'enforce') return scopes;
  const drop = new Set(rejected);
  return scopes.filter((scope) => !drop.has(scope));
}
