import { createSecretKey } from 'node:crypto';

import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../config';
import { createTokenVerifier, viewerAuthenticator } from '../tokens';
import {
  GRANT,
  signGrant,
  signTestToken,
  signViewer,
  testKeys,
  VIEWER,
} from '../test-support/keys';

const keys = testKeys();
const verifier = createTokenVerifier(keys.publicPem);
const auth = viewerAuthenticator(verifier);
const grantFields = { userId: '42', conversationId: 'c-1', idempotencyKey: 'k-1' };

describe('viewer tokens', () => {
  it('names the user a current viewer token is for', async () => {
    const token = await signViewer(keys, '42');
    expect(await auth.authenticate({ authorization: `Bearer ${token}` })).toEqual({
      ok: true,
      userId: '42',
    });
  });

  it('refuses a run grant presented as a viewer token (aud confusion)', async () => {
    const grant = await signGrant(keys, grantFields);
    expect(await auth.authenticate({ authorization: `Bearer ${grant}` })).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it('refuses a token with the viewer audience but the grant typ, and the reverse', async () => {
    const mixed = [
      await signTestToken(keys.privateKey, { aud: VIEWER.aud, typ: GRANT.typ, sub: '42' }),
      await signTestToken(keys.privateKey, { aud: GRANT.aud, typ: VIEWER.typ, sub: '42' }),
    ];
    for (const token of mixed)
      expect(await auth.authenticate({ authorization: `Bearer ${token}` })).toMatchObject({
        ok: false,
      });
  });

  it('refuses an expired viewer token, past the clock-skew allowance', async () => {
    const expired = await signViewer(keys, '42', -120);
    expect(await auth.authenticate({ authorization: `Bearer ${expired}` })).toMatchObject({
      ok: false,
      status: 401,
    });
    // Within the allowance a token that just expired on civitai's clock still counts.
    const justExpired = await signViewer(keys, '42', -5);
    expect(await auth.authenticate({ authorization: `Bearer ${justExpired}` })).toMatchObject({
      ok: true,
    });
  });

  it('refuses a token signed with another key, from another issuer, or with no algorithm', async () => {
    const other = testKeys();
    const forged = await signViewer(other, '42');
    const wrongIssuer = await signTestToken(keys.privateKey, {
      ...VIEWER,
      sub: '42',
      issuer: 'someone-else',
    });
    // A symmetric token keyed with the public key's text: the classic algorithm-confusion forgery.
    // With `alg: none` below, an invariant guard: jose refuses both for an EC key even without
    // `algorithms`, so these pin the outcome, not that option.
    const hmac = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: VIEWER.typ })
      .setIssuer('civitai')
      .setAudience(VIEWER.aud)
      .setSubject('42')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(createSecretKey(Buffer.from(keys.publicPem)));
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: VIEWER.typ })).toString(
      'base64url'
    )}.${Buffer.from(
      JSON.stringify({
        iss: 'civitai',
        aud: VIEWER.aud,
        sub: '42',
        exp: Math.floor(Date.now() / 1000) + 300,
      })
    ).toString('base64url')}.`;
    for (const token of [forged, wrongIssuer, hmac, unsigned])
      expect(await auth.authenticate({ authorization: `Bearer ${token}` })).toMatchObject({
        ok: false,
      });
  });

  it('never reads a cookie or another header as a credential', async () => {
    const token = await signViewer(keys, '42');
    expect(
      await auth.authenticate({
        cookie: `civ-token=${token}`,
        'x-civitai-token': token,
        'x-run-grant': token,
      })
    ).toMatchObject({ ok: false, status: 401 });
  });
});

describe('run grants', () => {
  it('reads who, which chat, which start and until when', async () => {
    const token = await signGrant(keys, grantFields, 7800);
    const grant = await verifier.grant(token);
    expect(grant).toMatchObject({ ...grantFields, token });
    expect(grant!.id).toMatch(/.+/);
    expect(grant!.expiresAt.getTime() - Date.now()).toBeGreaterThan(7700 * 1000);
  });

  it('reads subagents only from civitai’s claim, exactly `true`', async () => {
    const on = await verifier.grant(await signGrant(keys, grantFields, 7800, { subagents: true }));
    expect(on?.subagents).toBe(true);
    const off = await verifier.grant(await signGrant(keys, grantFields, 7800));
    expect(off?.subagents).toBe(false);
    const loose = await verifier.grant(
      await signGrant(keys, grantFields, 7800, { subagents: 'true' })
    );
    expect(loose?.subagents).toBe(false);
  });

  it('refuses a viewer token presented as a grant (aud confusion)', async () => {
    expect(await verifier.grant(await signViewer(keys, '42'))).toBeNull();
  });

  it('refuses a token carrying every grant claim but the viewer audience or typ, or another issuer', async () => {
    const claims = { cid: 'c-1', key: 'k-1' };
    // Control: the grant's own values pass, so each refusal below is its field's.
    expect(
      await verifier.grant(await signTestToken(keys.privateKey, { ...GRANT, sub: '42', claims }))
    ).not.toBeNull();
    for (const [name, options] of [
      ['viewer aud', { aud: VIEWER.aud, typ: GRANT.typ }],
      ['viewer typ', { aud: GRANT.aud, typ: VIEWER.typ }],
      ['both viewer', { ...VIEWER }],
      ['another issuer', { ...GRANT, issuer: 'elsewhere' }],
    ] as const)
      expect(
        await verifier.grant(
          await signTestToken(keys.privateKey, { ...options, sub: '42', claims })
        ),
        name
      ).toBeNull();
  });

  it('refuses an expired grant', async () => {
    expect(await verifier.grant(await signGrant(keys, grantFields, -120))).toBeNull();
  });

  it('refuses a grant missing its conversation or its key', async () => {
    const noChat = await signTestToken(keys.privateKey, {
      ...GRANT,
      sub: '42',
      claims: { key: 'k-1' },
    });
    const noKey = await signTestToken(keys.privateKey, {
      ...GRANT,
      sub: '42',
      claims: { cid: 'c-1' },
    });
    expect(await verifier.grant(noChat)).toBeNull();
    expect(await verifier.grant(noKey)).toBeNull();
  });

  it('refuses a grant civitai did not sign', async () => {
    expect(await verifier.grant(await signGrant(testKeys(), grantFields))).toBeNull();
  });
});

describe('configuration', () => {
  const base = { DATABASE_URL: 'postgres://localhost/x' };

  it('serves nobody without a public key', () => {
    expect(loadConfig(base).civitai).toBeUndefined();
  });

  it('refuses to start with a public key but half the rest', () => {
    expect(() => loadConfig({ ...base, RUNNER_TOKEN_PUBLIC_KEY: keys.publicPem })).toThrow(
      /RUNNER_SECRET, CIVITAI_URL, ORCHESTRATION_URL/
    );
  });

  it('refuses a runner secret shorter than 32 characters', () => {
    expect(() =>
      loadConfig({
        ...base,
        RUNNER_TOKEN_PUBLIC_KEY: keys.publicPem,
        RUNNER_SECRET: 'too-short',
        CIVITAI_URL: 'https://civitai.example',
        ORCHESTRATION_URL: 'https://orchestration.example',
      })
    ).toThrow(/at least 32/);
  });

  it('reads a one-line PEM and the base path', () => {
    const config = loadConfig({
      ...base,
      RUNNER_TOKEN_PUBLIC_KEY: keys.publicPem.replace(/\n/g, '\\n'),
      RUNNER_SECRET: 'test-only-runner-secret-0123456789abcdef',
      CIVITAI_URL: 'https://civitai.example',
      ORCHESTRATION_URL: 'https://orchestration.example',
      RUNNER_BASE_PATH: '/api/assistant-runner',
    });
    expect(config.basePath).toBe('/api/assistant-runner');
    expect(() => createTokenVerifier(config.civitai!.publicKey)).not.toThrow();
    expect(() => loadConfig({ ...base, RUNNER_BASE_PATH: '/api/assistant-runner/' })).toThrow();
  });
});
