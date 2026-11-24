import { isOrchestratorServiceToken } from '~/server/auth/orchestrator-service-token';
import { generateSecretHash } from '~/server/utils/key-generator';

/**
 * What a credentialed `/api/v1/models` or `/api/v1/models/[id]` shadow sample carries in place of
 * its API key (env `FEED_GO_SHADOW_V1_MODELS_CREDENTIALS`, default off; see `feed-go-shadow.ts`).
 * feed-go decides such a request from its own copy of the app's data (apps/feed-go DESIGN.md
 * §16.10); the sample tells it which credential to look up without the key leaving this process:
 *
 * - `none`: the credential gives no token (the cookies, or nothing, decide);
 * - `provider` / `service`: a token that never stands for a session, so feed-go needs no lookup
 *   (a `<provider>:<secret>` download token, the orchestrator service token);
 * - `dotted` (`[id]` only): a bearer holding `.`, which the block-scope middleware may verify as a
 *   block token;
 * - `key:<hash>`: any other token, as `generateSecretHash` of the trimmed token: the value the
 *   ApiKey row and the principal cache are keyed by, never the key itself.
 *
 * A `?token=` is never described: such a request is not sampled at all (the query string, and the
 * list body's `nextPage`, would carry it). Each returns undefined when there is no Authorization
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

/** The list (`MixedAuthEndpoint`): the token `readRequestBearerToken` reads from the header. */
export function listCredentialDescriptor(req: CredentialRequest): string | undefined {
  const header = authorizationHeader(req);
  if (header === undefined) return undefined;
  const token = header.split(' ')[1];
  return token ? describeToken(token) : 'none';
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
