import { randomUUID } from 'crypto';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import { SignJWT, createLocalJWKSet, errors as joseErrors, exportJWK, generateKeyPair } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';

const flipt = vi.hoisted(() => ({ isFlipt: vi.fn<typeof FliptClient.isFlipt>() }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: flipt.isFlipt,
}));

import { redisMock } from '~/__tests__/mocks/redis.mock';
import type { ActionsRunSource } from '~/server/schema/blocks/actions-run-source.schema';
import {
  assertActionsRunRepositoryPinned,
  publicActionsRunSource,
  readActionsRunSourcesForRender,
  readLiveActionsRunSourceForListing,
  writeActionsRunSource,
} from '~/server/services/blocks/actions-run-source.service';
import {
  GithubActionsOidcRefusal,
  actionsOidcTokenForSubmit,
  verifyGithubActionsOidcToken,
} from '~/server/services/blocks/github-actions-oidc.service';

/**
 * GitHub Actions OIDC provenance for an App submit.
 *
 * Every token here is signed by a key generated in this file and resolved through a LOCAL JWKS
 * (`createLocalJWKSet`), injected in place of GitHub's remote key set — so the whole jose
 * verification path (signature, `iss`, `aud`, `exp`) runs for real, with no network.
 *
 * Fixture values are chosen to be distinct from each other and from every constant the service
 * names, so a mutant that hardcodes one of them cannot pass.
 */

const KID = 'test-key-1';
// Literals, not the service's constants: what GitHub issues and what the Action requests are
// wire contracts, so a changed constant must fail here rather than sign along with it.
const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
const CIVITAI_AUDIENCE = 'civitai.com';
const SHA = '3e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f';
const OTHER_SHA = '0f9e8d7c6b5a49382716fedcba9876543210abcd';
const VERSION = '1.4.2';
const NOW_S = 1_900_000_000;

let signingKey: CryptoKey;
let getKey: JWTVerifyGetKey;
let strangerKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  signingKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  getKey = createLocalJWKSet({ keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] });
  strangerKey = (await generateKeyPair('RS256')).privateKey;
});

function claims(over: Partial<Record<string, unknown>> = {}): JWTPayload {
  return {
    repository: 'acme-studio/pixel-garden',
    repository_id: '612340987',
    repository_owner: 'acme-studio',
    repository_owner_id: '7781234',
    repository_visibility: 'public',
    ref: `refs/tags/v${VERSION}`,
    ref_type: 'tag',
    sha: SHA,
    event_name: 'push',
    workflow_ref: `acme-studio/pixel-garden/.github/workflows/release.yml@refs/tags/v${VERSION}`,
    run_id: '19283746501',
    jti: randomUUID(),
    ...over,
  };
}

async function sign(
  payload: JWTPayload,
  opts: { iss?: string; aud?: string; iat?: number; exp?: number; key?: CryptoKey } = {}
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(opts.iss ?? GITHUB_ISSUER)
    .setAudience(opts.aud ?? CIVITAI_AUDIENCE)
    .setIssuedAt(opts.iat ?? NOW_S - 30)
    .setExpirationTime(opts.exp ?? NOW_S + 270)
    .sign(opts.key ?? signingKey);
}

/** A jti store per test, so replay is observable without Redis. */
let seen: Set<string>;
function deps() {
  return {
    getKey,
    now: () => NOW_S * 1000,
    claimJti: async (jti: string) => {
      if (seen.has(jti)) return false;
      seen.add(jti);
      return true;
    },
  };
}

async function refusal(promise: Promise<unknown>): Promise<GithubActionsOidcRefusal> {
  const err = await promise.then(
    () => {
      throw new Error('expected the token to be refused');
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(GithubActionsOidcRefusal);
  return err as GithubActionsOidcRefusal;
}

beforeEach(() => {
  vi.clearAllMocks();
  seen = new Set();
});

describe('verifyGithubActionsOidcToken', () => {
  it('accepts a tag-push token and returns exactly the run facts it stores', async () => {
    const source = await verifyGithubActionsOidcToken(
      await sign(claims()),
      { manifestVersion: VERSION, sourceCommit: SHA },
      deps()
    );
    expect(source).toEqual<ActionsRunSource>({
      repository: 'acme-studio/pixel-garden',
      repositoryId: '612340987',
      repositoryOwnerId: '7781234',
      sha: SHA,
      ref: `refs/tags/v${VERSION}`,
      workflowRef: `acme-studio/pixel-garden/.github/workflows/release.yml@refs/tags/v${VERSION}`,
      repositoryVisibility: 'public',
      runId: '19283746501',
    });
  });

  it('accepts a bare-version tag (no leading v) and a submit that sent no sourceCommit', async () => {
    const source = await verifyGithubActionsOidcToken(
      await sign(claims({ ref: `refs/tags/${VERSION}` })),
      { manifestVersion: VERSION },
      deps()
    );
    expect(source.ref).toBe(`refs/tags/${VERSION}`);
  });

  it('refuses a token from another issuer', async () => {
    const err = await refusal(
      verifyGithubActionsOidcToken(
        await sign(claims(), { iss: 'https://token.actions.example.net' }),
        { manifestVersion: VERSION },
        deps()
      )
    );
    expect(err.reason).toBe('issuer');
    expect(err.status).toBe(400);
  });

  it('refuses a token minted for another audience', async () => {
    const err = await refusal(
      verifyGithubActionsOidcToken(
        await sign(claims(), { aud: 'https://github.com/acme-studio' }),
        { manifestVersion: VERSION },
        deps()
      )
    );
    expect(err.reason).toBe('audience');
  });

  it('refuses an expired token, past the leeway', async () => {
    const err = await refusal(
      verifyGithubActionsOidcToken(
        await sign(claims(), { iat: NOW_S - 900, exp: NOW_S - 120 }),
        { manifestVersion: VERSION },
        deps()
      )
    );
    expect(err.reason).toBe('expired');
  });

  it('allows a token a few seconds past exp (clock-skew leeway)', async () => {
    const source = await verifyGithubActionsOidcToken(
      await sign(claims(), { iat: NOW_S - 300, exp: NOW_S - 5 }),
      { manifestVersion: VERSION },
      deps()
    );
    expect(source.sha).toBe(SHA);
  });

  it('refuses a token signed by a key GitHub does not publish', async () => {
    const err = await refusal(
      verifyGithubActionsOidcToken(
        await sign(claims(), { key: strangerKey }),
        { manifestVersion: VERSION },
        deps()
      )
    );
    expect(err.reason).toBe('signature');
  });

  it('refuses the same token twice (one-use jti)', async () => {
    const token = await sign(claims());
    await verifyGithubActionsOidcToken(token, { manifestVersion: VERSION }, deps());
    const err = await refusal(
      verifyGithubActionsOidcToken(token, { manifestVersion: VERSION }, deps())
    );
    expect(err.reason).toBe('replayed');
  });

  it('refuses a branch push', async () => {
    const err = await refusal(
      verifyGithubActionsOidcToken(
        await sign(claims({ ref: 'refs/heads/main', ref_type: 'branch' })),
        { manifestVersion: VERSION },
        deps()
      )
    );
    expect(err.reason).toBe('not-a-tag');
  });

  it('refuses a tag that is not the manifest version', async () => {
    const err = await refusal(
      verifyGithubActionsOidcToken(
        await sign(claims({ ref: 'refs/tags/v1.4.3' })),
        { manifestVersion: VERSION },
        deps()
      )
    );
    expect(err.reason).toBe('tag-version-mismatch');
    expect(err.message).toContain('v1.4.3');
    expect(err.message).toContain(VERSION);
  });

  it('refuses a token whose sha is not the sourceCommit the client sent', async () => {
    const err = await refusal(
      verifyGithubActionsOidcToken(
        await sign(claims()),
        { manifestVersion: VERSION, sourceCommit: OTHER_SHA },
        deps()
      )
    );
    expect(err.reason).toBe('sha-mismatch');
  });

  it('refuses a token from a non-push event', async () => {
    const err = await refusal(
      verifyGithubActionsOidcToken(
        await sign(claims({ event_name: 'workflow_dispatch' })),
        { manifestVersion: VERSION },
        deps()
      )
    );
    expect(err.reason).toBe('not-a-push');
  });

  it('refuses a token missing a claim it must store', async () => {
    const err = await refusal(
      verifyGithubActionsOidcToken(
        await sign(claims({ repository_id: undefined })),
        { manifestVersion: VERSION },
        deps()
      )
    );
    expect(err.reason).toBe('missing-claim');
  });

  it('never puts the token in a refusal message', async () => {
    const token = await sign(claims({ ref: 'refs/heads/main', ref_type: 'branch' }));
    const err = await refusal(
      verifyGithubActionsOidcToken(token, { manifestVersion: VERSION }, deps())
    );
    expect(err.message).not.toContain(token.split('.')[1]);
  });

  it('by default records the jti in Redis with NX and a TTL, and refuses when it was already there', async () => {
    redisMock.redis.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    const token = await sign(claims());
    const { claimJti: _local, ...noStore } = deps();
    await verifyGithubActionsOidcToken(token, { manifestVersion: VERSION }, noStore);
    const [key, , opts] = redisMock.redis.set.mock.calls[0] as [
      string,
      string,
      { NX: boolean; EX: number }
    ];
    expect(key).toContain('actions-oidc-jti');
    expect(opts.NX).toBe(true);
    expect(opts.EX).toBeGreaterThan(0);
    expect(opts.EX).toBeLessThanOrEqual(3600);
    const err = await refusal(
      verifyGithubActionsOidcToken(token, { manifestVersion: VERSION }, noStore)
    );
    expect(err.reason).toBe('replayed');
  });

  it('a Redis failure on the replay check refuses with a retryable 503, never accepts', async () => {
    redisMock.redis.set.mockRejectedValueOnce(new Error('connection reset'));
    const { claimJti: _local, ...noStore } = deps();
    const err = await refusal(
      verifyGithubActionsOidcToken(await sign(claims()), { manifestVersion: VERSION }, noStore)
    );
    expect(err.status).toBe(503);
  });
});

describe('verifyGithubActionsOidcToken — algorithms and the key set', () => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const payload = () => ({
    ...claims(),
    iss: GITHUB_ISSUER,
    aud: CIVITAI_AUDIENCE,
    iat: NOW_S - 30,
    exp: NOW_S + 270,
  });

  it('refuses an unsigned token (alg: none) as malformed, 400', async () => {
    const token = `${b64({ alg: 'none', kid: KID })}.${b64(payload())}.`;
    const err = await refusal(
      verifyGithubActionsOidcToken(token, { manifestVersion: VERSION }, deps())
    );
    expect(err.reason).toBe('malformed');
    expect(err.status).toBe(400);
  });

  it('refuses an HS256 token (a shared-secret algorithm GitHub never uses) as malformed, 400', async () => {
    const token = await new SignJWT(payload())
      .setProtectedHeader({ alg: 'HS256', kid: KID })
      .sign(new TextEncoder().encode('a-shared-secret-of-at-least-32-bytes!!'));
    const err = await refusal(
      verifyGithubActionsOidcToken(token, { manifestVersion: VERSION }, deps())
    );
    expect(err.reason).toBe('malformed');
    expect(err.status).toBe(400);
  });

  it.each([
    ['a key-set timeout', () => new joseErrors.JWKSTimeout()],
    [
      'a non-200 key-set response',
      () => new joseErrors.JOSEError('Expected 200 OK from the JSON Web Key Set HTTP response'),
    ],
    ['a network failure', () => new TypeError('fetch failed')],
  ])('maps %s to a retryable 503, not a token error', async (_name, makeError) => {
    const unavailable: JWTVerifyGetKey = async () => {
      throw makeError();
    };
    const err = await refusal(
      verifyGithubActionsOidcToken(
        await sign(claims()),
        { manifestVersion: VERSION },
        { ...deps(), getKey: unavailable }
      )
    );
    expect(err.reason).toBe('unavailable');
    expect(err.status).toBe(503);
  });
});

describe('actionsOidcTokenForSubmit — the flag', () => {
  const user = { id: 9104, username: 'pixel-dev' } as never;

  it('flag off: the token is dropped, so nothing is verified or stored', async () => {
    flipt.isFlipt.mockResolvedValue(false);
    await expect(actionsOidcTokenForSubmit(user, 'header.payload.sig')).resolves.toBeUndefined();
    // The key Flipt holds; a rename here would silently read an absent flag as off.
    expect(flipt.isFlipt.mock.calls[0][0]).toBe('app-blocks-oidc-verified-submit');
    // Per submitter: entityId is the user id, with the segment context.
    expect(flipt.isFlipt.mock.calls[0][1]).toBe('9104');
  });

  it('flag on: the token passes through', async () => {
    flipt.isFlipt.mockResolvedValue(true);
    await expect(actionsOidcTokenForSubmit(user, 'header.payload.sig')).resolves.toBe(
      'header.payload.sig'
    );
  });

  it('Flipt throwing reads as off', async () => {
    flipt.isFlipt.mockRejectedValue(new Error('flipt unreachable'));
    await expect(actionsOidcTokenForSubmit(user, 'header.payload.sig')).resolves.toBeUndefined();
  });

  it('no token: the flag is not even read', async () => {
    await expect(actionsOidcTokenForSubmit(user, undefined)).resolves.toBeUndefined();
    expect(flipt.isFlipt).not.toHaveBeenCalled();
  });
});

const SOURCE: ActionsRunSource = {
  repository: 'acme-studio/pixel-garden',
  repositoryId: '612340987',
  repositoryOwnerId: '7781234',
  sha: SHA,
  ref: `refs/tags/v${VERSION}`,
  workflowRef: 'acme-studio/pixel-garden/.github/workflows/release.yml@refs/tags/v1.4.2',
  repositoryVisibility: 'public',
  runId: '19283746501',
};

const missingColumn = Object.assign(new Error('column "actions_run_sha" does not exist'), {
  code: 'P2010',
  meta: { code: '42703' },
});

describe('columns absent (migration not applied yet)', () => {
  it('the write reports not-recorded instead of throwing', async () => {
    const db = { $executeRaw: vi.fn().mockRejectedValue(missingColumn) };
    await expect(writeActionsRunSource(db, 'pubreq_01TEST', SOURCE)).resolves.toBe(false);
  });

  it('the moderator read degrades to no rows', async () => {
    const db = { $queryRaw: vi.fn().mockRejectedValue(missingColumn) };
    await expect(readActionsRunSourcesForRender(db, ['pubreq_01TEST'])).resolves.toEqual(new Map());
  });

  it('the public listing read degrades to null', async () => {
    const db = { $queryRaw: vi.fn().mockRejectedValue(missingColumn) };
    await expect(readLiveActionsRunSourceForListing(db, 'apb_01TEST')).resolves.toBeNull();
  });

  it('the write names every column when they exist', async () => {
    const db = { $executeRaw: vi.fn().mockResolvedValue(1) };
    await expect(writeActionsRunSource(db, 'pubreq_01TEST', SOURCE)).resolves.toBe(true);
    const [strings, ...values] = db.$executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[]
    ];
    const sql = strings.join('?');
    for (const col of [
      'actions_run_repository',
      'actions_run_repository_id',
      'actions_run_repository_owner_id',
      'actions_run_sha',
      'actions_run_ref',
      'actions_run_workflow_ref',
      'actions_run_repository_visibility',
      'actions_run_id',
    ]) {
      expect(sql).toContain(`"${col}"`);
    }
    expect(values).toEqual(
      expect.arrayContaining([SOURCE.repository, SOURCE.sha, SOURCE.runId, 'pubreq_01TEST'])
    );
  });
});

describe('the public Source row is for public repositories only', () => {
  it('public: owner/repo, tag and sha', () => {
    expect(publicActionsRunSource(SOURCE)).toEqual({
      repository: 'acme-studio/pixel-garden',
      tag: 'v1.4.2',
      sha: SHA,
    });
  });

  it('private and internal repositories show nothing', () => {
    expect(publicActionsRunSource({ ...SOURCE, repositoryVisibility: 'private' })).toBeNull();
    expect(publicActionsRunSource({ ...SOURCE, repositoryVisibility: 'internal' })).toBeNull();
  });

  it('the listing read returns the row only for a public repository', async () => {
    const row = (visibility: string) => ({
      repository: SOURCE.repository,
      repositoryId: SOURCE.repositoryId,
      repositoryOwnerId: SOURCE.repositoryOwnerId,
      sha: SOURCE.sha,
      ref: SOURCE.ref,
      workflowRef: SOURCE.workflowRef,
      repositoryVisibility: visibility,
      runId: SOURCE.runId,
    });
    const pub = { $queryRaw: vi.fn().mockResolvedValue([row('public')]) };
    const priv = { $queryRaw: vi.fn().mockResolvedValue([row('private')]) };
    await expect(readLiveActionsRunSourceForListing(pub, 'apb_01TEST')).resolves.toEqual({
      repository: 'acme-studio/pixel-garden',
      tag: 'v1.4.2',
      sha: SHA,
    });
    await expect(readLiveActionsRunSourceForListing(priv, 'apb_01TEST')).resolves.toBeNull();
  });
});

describe("the repository pin: an app's verified submits stay on one repository", () => {
  const SLUG = 'knot-tier-pin-4410';
  const pinRow = (repositoryId: string, repository: string) => ({
    $queryRaw: vi.fn().mockResolvedValue([{ repositoryId, repository }]),
  });

  it('the first verified submit is accepted (nothing pinned yet) — its stored repository_id becomes the pin', async () => {
    const db = { $queryRaw: vi.fn().mockResolvedValue([]) };
    await expect(assertActionsRunRepositoryPinned(db, SLUG, SOURCE)).resolves.toBeUndefined();
    // The pin is read for THIS app, from earlier verified, non-withdrawn, non-rejected requests.
    const [strings, ...values] = db.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(values).toEqual([SLUG]);
    const sql = strings.join('?');
    expect(sql).toContain('"actions_run_repository_id" IS NOT NULL');
    expect(sql).toContain(`"status" IN ('pending', 'approved')`);
    expect(sql).toContain('ORDER BY "submitted_at" ASC');
  });

  it('a later submit from the same repository is accepted, even after a rename', async () => {
    const db = pinRow(SOURCE.repositoryId, 'acme-studio/old-name');
    await expect(assertActionsRunRepositoryPinned(db, SLUG, SOURCE)).resolves.toBeUndefined();
  });

  it('a submit from a different repository is refused 409, naming the expected one', async () => {
    const db = pinRow('550001234', 'acme-studio/pixel-garden-original');
    const err = await refusal(assertActionsRunRepositoryPinned(db, SLUG, SOURCE));
    expect(err.reason).toBe('repository-mismatch');
    expect(err.status).toBe(409);
    expect(err.message).toBe(
      "GitHub Actions OIDC token rejected: this app's verified submits come from " +
        'acme-studio/pixel-garden-original (repository id 550001234), but this token is from ' +
        'acme-studio/pixel-garden (repository id 612340987). Submit from acme-studio/pixel-garden-original.'
    );
  });

  it('columns absent: no pin can exist, so the submit proceeds as today', async () => {
    const db = { $queryRaw: vi.fn().mockRejectedValue(missingColumn) };
    await expect(assertActionsRunRepositoryPinned(db, SLUG, SOURCE)).resolves.toBeUndefined();
  });

  it('any other read failure refuses with a retryable 503 rather than skipping the pin', async () => {
    const db = { $queryRaw: vi.fn().mockRejectedValue(new Error('connection terminated')) };
    const err = await refusal(assertActionsRunRepositoryPinned(db, SLUG, SOURCE));
    expect(err.status).toBe(503);
  });
});
