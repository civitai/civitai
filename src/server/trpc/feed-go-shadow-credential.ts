import { isOrchestratorServiceToken } from '~/server/auth/orchestrator-service-token';
import { generateSecretHash } from '~/server/utils/key-generator';

/**
 * What a credentialed `/api/v1/models/[id]` or `/api/v1/images` shadow sample carries in place of its
 * API key (env `FEED_GO_SHADOW_V1_MODELS_CREDENTIALS` / `FEED_GO_SHADOW_V1_IMAGES_CREDENTIALS`, each
 * default off; see `feed-go-shadow.ts`).
 * feed-go decides such a request from its own copy of the app's data (apps/feed-go DESIGN.md
 * §16.10); the sample tells it which credential to look up without the key leaving this process:
 *
 * - `none`: the credential gives no bearer (no `Bearer ` value, or an empty one);
 * - `provider` / `service`: a token that never stands for a session, so feed-go needs no lookup
 *   (a `<provider>:<secret>` download token, the orchestrator service token);
 * - `dotted` (`[id]` only): a bearer holding `.`, which the block-scope middleware may verify as a
 *   block token;
 * - `key:<hash>`: any other token, as `generateSecretHash` of the trimmed token: the value the
 *   ApiKey row and the principal cache are keyed by, never the key itself.
 *
 * Each route reads the bearer its own way: `[id]` as `withBlockScope` does
 * (`blockCredentialDescriptor`), the images route as `getServerAuthSession` does
 * (`apiCredentialDescriptor`, `readRequestBearerToken`'s `split(' ')[1]`, where a header with no token
 * part is `none`: the app then resolves the cookies).
 *
 * A `?token=` is never described: such a request is not sampled at all (the query string would
 * carry it). The list route samples no credentialed request. Each returns undefined when there is no Authorization
 * header to describe. The sample carries the description as FEED_GO_SAMPLE_CREDENTIAL_HEADER.
 */

type CredentialRequest = { headers: Record<string, string | string[] | undefined> };

function authorizationHeader(req: CredentialRequest): string | undefined {
  const v = req.headers.authorization;
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** The description of a token `getSessionFromBearerToken` would be handed. */
function describeToken(token: string): string {
  if (token.includes(':')) return 'provider';
  const trimmed = token.trim();
  if (isOrchestratorServiceToken(trimmed)) return 'service';
  return `key:${generateSecretHash(trimmed)}`;
}

/** `[id]` (`withBlockScope`): the bearer it reads, `authorization.slice('bearer '.length).trim()`. */
export function blockCredentialDescriptor(req: CredentialRequest): string | undefined {
  const header = authorizationHeader(req);
  if (header === undefined) return undefined;
  if (!header.toLowerCase().startsWith('bearer ')) return 'none';
  const bearer = header.slice('bearer '.length).trim();
  if (!bearer) return 'none';
  if (bearer.includes('.')) return 'dotted';
  return describeToken(bearer);
}

/**
 * `/api/v1/images` (`getApiAuthSession` → `readRequestBearerToken`): the token it reads,
 * `authorization.split(' ')[1]` whatever the scheme, described as `getSessionFromBearerToken` would be
 * handed it (`describeToken`). A header with no token part is `none`. No `dotted`: this route verifies
 * no block token, so a bearer holding `.` is hashed like any key (and is a cache miss in feed-go).
 */
export function apiCredentialDescriptor(req: CredentialRequest): string | undefined {
  const header = authorizationHeader(req);
  if (header === undefined) return undefined;
  const token = header.split(' ')[1];
  if (!token) return 'none';
  return describeToken(token);
}
