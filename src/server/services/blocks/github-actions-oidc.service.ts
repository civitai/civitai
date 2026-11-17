/**
 * App submits from GitHub Actions: verify the run's OIDC token (storage and reads of the verified
 * run are in `actions-run-source.service.ts`).
 *
 * The `civitai/app-submit-action` Action asks GitHub for an OIDC token on a tag push and sends it
 * with `civitai app submit`. GitHub signs that token with a key from its public JWKS, so the server
 * can check which repository, tag and commit the submitting run belongs to.
 *
 * 🔴 THE LIMIT OF THE CLAIM. A valid token proves the SUBMIT came from a GitHub Actions run of
 * <repository> for <tag> at <sha>. It does not prove the uploaded bundle was built from that commit:
 * the developer's own workflow builds and uploads the bundle, and could upload anything. So the
 * stored fields are named for the run (`actions_run_*`), and every surface that shows them says
 * "submitted by a GitHub Actions run of …", never "verified", "secure" or "built by Civitai".
 * Moderator approval is unchanged by any of this.
 *
 * 🔴 A SEPARATE TRUST LEVEL. `source_commit` / `source_dirty` are what the client claimed; these
 * columns are what GitHub signed. Nothing here reads, defaults from or falls back to the claim (the
 * one link is a refusal: a client that sends a `sourceCommit` different from the token's `sha` is
 * refused, because the two can only disagree in a broken or dishonest pipeline).
 *
 * The eight `actions_run_*` columns the result is stored in are manual-apply and no-type, so this
 * deploys before the migration is applied (see `actions-run-source.service.ts`). Apply the migration
 * BEFORE turning the flag on, or verified runs are checked and then not recorded.
 *
 * Flag `app-blocks-oidc-verified-submit` (per submitter). Off, absent or Flipt unreachable: the
 * token is ignored entirely, never verified and never stored, and the submit behaves as it did
 * before this existed.
 */

import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose';

import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import type { ActionsRunSource } from '~/server/schema/blocks/actions-run-source.schema';
import { GithubActionsOidcRefusal } from '~/server/services/blocks/github-actions-oidc-refusal';
import { buildFliptContext } from '~/server/services/feature-flags.service';
import type { SessionUser } from '~/types/session';

export {
  GithubActionsOidcRefusal,
  isGithubActionsOidcRefusal,
  type ActionsOidcRefusalReason,
} from '~/server/services/blocks/github-actions-oidc-refusal';

export const ACTIONS_OIDC_SUBMIT_FLAG = FLIPT_FEATURE_FLAGS.APP_BLOCKS_OIDC_VERIFIED_SUBMIT;

/** GitHub's token issuer for Actions. A GitHub Enterprise custom issuer is not accepted. */
export const GITHUB_ACTIONS_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
export const GITHUB_ACTIONS_OIDC_JWKS_URL = `${GITHUB_ACTIONS_OIDC_ISSUER}/.well-known/jwks`;
/**
 * The audience the Action requests and the server pins. A token GitHub minted for any other
 * audience (another service's) is refused, so it cannot be replayed here.
 */
export const CIVITAI_ACTIONS_OIDC_AUDIENCE = 'civitai.com';

/** Clock-skew leeway on `exp` / `nbf` / `iat`, in seconds. */
const CLOCK_TOLERANCE_SECONDS = 30;
/** A token older than this is refused whatever its `exp` says (GitHub's live for minutes). */
const MAX_TOKEN_AGE_SECONDS = 60 * 60;
/** The replay marker outlives the token by the leeway, capped at the max age. */
const MAX_JTI_TTL_SECONDS = MAX_TOKEN_AGE_SECONDS;

const SHA_RE = /^[0-9a-f]{40}$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const VISIBILITIES = new Set(['public', 'private', 'internal']);
const TAG_REF_PREFIX = 'refs/tags/';

// ---------------------------------------------------------------------------
// The flag
// ---------------------------------------------------------------------------

/**
 * The token to verify for this submitter, or `undefined` when there is none or the flag is off.
 * Both submit routes call this, so "flag off ⇒ the token is ignored" holds in one place.
 * A Flipt error reads as off.
 */
export async function actionsOidcTokenForSubmit(
  user: SessionUser,
  token: string | undefined
): Promise<string | undefined> {
  if (!token) return undefined;
  try {
    const on = await isFlipt(ACTIONS_OIDC_SUBMIT_FLAG, String(user.id), buildFliptContext(user));
    return on ? token : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

let githubJwks: JWTVerifyGetKey | undefined;
/**
 * GitHub's key set, fetched on first use and cached by jose (refetched at most every 10 minutes,
 * or sooner when a token names a key id it has not seen, with a 30 s cooldown).
 */
function githubActionsJwks(): JWTVerifyGetKey {
  return (githubJwks ??= createRemoteJWKSet(new URL(GITHUB_ACTIONS_OIDC_JWKS_URL), {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
  }));
}

/**
 * Record `jti` as used. `true` = first use; `false` = already seen (a replay). Throws when Redis
 * cannot answer, which the caller turns into a 503: never accept a token whose replay status is
 * unknown.
 *
 * On the cache cluster with a TTL, not `sysRedis`: the marker is short-lived and only needs to
 * outlive the token. An eviction under memory pressure would reopen the window for that one token
 * until it expires, which the TTL cap bounds.
 */
async function claimJtiInRedis(jti: string, ttlSeconds: number): Promise<boolean> {
  const key: `${typeof REDIS_KEYS.BLOCKS.ACTIONS_OIDC_JTI}:${string}` = `${REDIS_KEYS.BLOCKS.ACTIONS_OIDC_JTI}:${jti}`;
  const set = await redis.set(key, '1', { NX: true, EX: ttlSeconds });
  return set !== null;
}

export type ActionsOidcVerifyDeps = {
  /** Key resolver; GitHub's remote JWKS by default. Tests pass a local key set. */
  getKey?: JWTVerifyGetKey;
  /** One-use store; Redis by default. */
  claimJti?: (jti: string, ttlSeconds: number) => Promise<boolean>;
  /** Clock in ms; `Date.now` by default. */
  now?: () => number;
};

function stringClaim(payload: JWTPayload, name: string): string {
  const v = payload[name];
  if (typeof v !== 'string' || v.length === 0) {
    throw new GithubActionsOidcRefusal('missing-claim', `the token has no "${name}" claim`);
  }
  return v;
}

function mapJoseError(err: unknown): GithubActionsOidcRefusal {
  if (err instanceof GithubActionsOidcRefusal) return err;
  if (err instanceof joseErrors.JWTExpired) {
    return new GithubActionsOidcRefusal('expired', 'the token has expired');
  }
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    if (err.claim === 'iss') {
      return new GithubActionsOidcRefusal(
        'issuer',
        `the issuer must be ${GITHUB_ACTIONS_OIDC_ISSUER}`
      );
    }
    if (err.claim === 'aud') {
      return new GithubActionsOidcRefusal(
        'audience',
        `the audience must be "${CIVITAI_ACTIONS_OIDC_AUDIENCE}"; request the token with that audience`
      );
    }
    if (err.claim === 'iat') {
      return new GithubActionsOidcRefusal('expired', 'the token is too old');
    }
    return new GithubActionsOidcRefusal('invalid-claims', `the "${err.claim}" claim is invalid`);
  }
  if (
    err instanceof joseErrors.JWSSignatureVerificationFailed ||
    err instanceof joseErrors.JWKSNoMatchingKey ||
    err instanceof joseErrors.JWKSMultipleMatchingKeys
  ) {
    return new GithubActionsOidcRefusal(
      'signature',
      'the signature does not match a GitHub Actions key'
    );
  }
  if (
    err instanceof joseErrors.JWSInvalid ||
    err instanceof joseErrors.JWTInvalid ||
    err instanceof joseErrors.JOSEAlgNotAllowed ||
    err instanceof joseErrors.JOSENotSupported
  ) {
    return new GithubActionsOidcRefusal('malformed', 'the token is not a valid signed JWT');
  }
  // Any OTHER specific jose error is about the token, so it is a 400 like the ones above. Only the
  // key-set fetch failing is a 503: a timeout, an unparseable key set, jose's bare `JOSEError`
  // (which is what it throws for a non-200 key-set response) or a non-jose error (the network).
  if (
    err instanceof joseErrors.JOSEError &&
    err.constructor !== joseErrors.JOSEError &&
    !(err instanceof joseErrors.JWKSTimeout) &&
    !(err instanceof joseErrors.JWKSInvalid)
  ) {
    return new GithubActionsOidcRefusal('malformed', 'the token is not a valid signed JWT');
  }
  return new GithubActionsOidcRefusal(
    'unavailable',
    'could not fetch GitHub Actions signing keys; re-run the workflow',
    503
  );
}

/**
 * Verify a GitHub Actions OIDC token for an App submit and return the run facts to store.
 * Throws {@link GithubActionsOidcRefusal} on any failure.
 *
 * Checks, in order: signature against GitHub's JWKS (RS256), issuer, the pinned audience, expiry
 * and age with {@link CLOCK_TOLERANCE_SECONDS} of leeway; every stored claim present and well formed;
 * `event_name` is `push`; `ref_type` is `tag`; the tag is the manifest version (`v1.2.3` or
 * `1.2.3`); when the client sent `sourceCommit`, it is the token's `sha`. Last, the token's `jti`
 * is recorded as used, so the same token cannot be presented twice.
 */
export async function verifyGithubActionsOidcToken(
  token: string,
  expected: { manifestVersion: string; sourceCommit?: string },
  deps: ActionsOidcVerifyDeps = {}
): Promise<ActionsRunSource> {
  const nowMs = (deps.now ?? Date.now)();
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, deps.getKey ?? githubActionsJwks(), {
      issuer: GITHUB_ACTIONS_OIDC_ISSUER,
      audience: CIVITAI_ACTIONS_OIDC_AUDIENCE,
      algorithms: ['RS256'],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      maxTokenAge: MAX_TOKEN_AGE_SECONDS,
      requiredClaims: ['exp', 'iat', 'jti'],
      currentDate: new Date(nowMs),
    }));
  } catch (err) {
    throw mapJoseError(err);
  }

  const source: ActionsRunSource = {
    repository: stringClaim(payload, 'repository'),
    repositoryId: stringClaim(payload, 'repository_id'),
    repositoryOwnerId: stringClaim(payload, 'repository_owner_id'),
    sha: stringClaim(payload, 'sha'),
    ref: stringClaim(payload, 'ref'),
    workflowRef: stringClaim(payload, 'workflow_ref'),
    repositoryVisibility: stringClaim(payload, 'repository_visibility'),
    runId: stringClaim(payload, 'run_id'),
  };
  const eventName = stringClaim(payload, 'event_name');
  const refType = stringClaim(payload, 'ref_type');
  const jti = stringClaim(payload, 'jti');

  if (
    !SHA_RE.test(source.sha) ||
    !REPOSITORY_RE.test(source.repository) ||
    !VISIBILITIES.has(source.repositoryVisibility)
  ) {
    throw new GithubActionsOidcRefusal('invalid-claims', 'the token carries a malformed run claim');
  }
  if (eventName !== 'push') {
    throw new GithubActionsOidcRefusal(
      'not-a-push',
      `the workflow ran for a "${eventName}" event; submit from a tag push`
    );
  }
  if (refType !== 'tag' || !source.ref.startsWith(TAG_REF_PREFIX)) {
    throw new GithubActionsOidcRefusal(
      'not-a-tag',
      `the workflow ran for ${source.ref}, not a tag; submit from a tag push`
    );
  }
  const tag = source.ref.slice(TAG_REF_PREFIX.length);
  const version = expected.manifestVersion;
  if (tag !== version && tag !== `v${version}`) {
    throw new GithubActionsOidcRefusal(
      'tag-version-mismatch',
      `tag ${tag} does not match the manifest version ${version} (expected v${version} or ${version})`
    );
  }
  if (expected.sourceCommit !== undefined && expected.sourceCommit !== source.sha) {
    throw new GithubActionsOidcRefusal(
      'sha-mismatch',
      `sourceCommit ${expected.sourceCommit.slice(
        0,
        7
      )} is not the commit the workflow ran for (${source.sha.slice(0, 7)})`
    );
  }

  const exp = typeof payload.exp === 'number' ? payload.exp : 0;
  const ttl = Math.min(
    Math.max(Math.ceil(exp - nowMs / 1000) + CLOCK_TOLERANCE_SECONDS, 60),
    MAX_JTI_TTL_SECONDS
  );
  let first: boolean;
  try {
    first = await (deps.claimJti ?? claimJtiInRedis)(jti, ttl);
  } catch {
    throw new GithubActionsOidcRefusal(
      'unavailable',
      'could not check whether the token was already used; re-run the workflow',
      503
    );
  }
  if (!first) {
    throw new GithubActionsOidcRefusal('replayed', 'this token was already used for a submit');
  }
  return source;
}
