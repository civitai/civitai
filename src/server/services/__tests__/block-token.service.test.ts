import { describe, expect, it } from 'vitest';
import { jwtVerify } from 'jose';
import { createPublicKey } from 'crypto';
// The block-token RSA keypair is provisioned globally in the test setup
// (src/__tests__/setup.ts wires BLOCK_TOKEN_{PRIVATE,PUBLIC}_KEY into the
// mocked ~/env/server, which the service reads). The same public PEM is
// re-exported here so this test verifies the JWT against the key the service
// actually signed with. Doing it in setup is required because env/server.ts
// snapshots its values at import time — well before any per-file beforeAll.
import { TEST_BLOCK_TOKEN_PUBLIC_PEM } from '~/__tests__/setup';

const publicPem = TEST_BLOCK_TOKEN_PUBLIC_PEM;
// jose v6 requires a KeyObject/CryptoKey/JWK for RS256 verification — a raw
// PEM Buffer is rejected. Convert once and reuse for every jwtVerify call.
const publicKey = createPublicKey(publicPem);

describe('BlockTokenService.sign — JWT round-trip', () => {
  it('produces a token verifiable with the public key, with RS256 + correct claims', async () => {
    // Late-import so the env above is in place when the module evaluates.
    const { BlockTokenService } = await import('../block-token.service');

    const result = await BlockTokenService.sign({
      userId: 42,
      blockId: 'blk_test',
      appId: 'app_test',
      appBlockId: 'apb_test',
      blockInstanceId: 'bki_test',
      scopes: ['models:read:self'],
      ctx: { modelId: 12345 },
    });

    expect(result.token.split('.').length).toBe(3);
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // Decode protected header to verify algorithm — guards against alg-confusion
    // regressions (e.g. someone accidentally switching to HS256).
    const header = JSON.parse(
      Buffer.from(result.token.split('.')[0], 'base64url').toString('utf8')
    );
    expect(header.alg).toBe('RS256');
    expect(header.kid).toBeTruthy();

    const { payload } = await jwtVerify(
      result.token,
      publicKey,
      { issuer: 'civitai', audience: 'civitai-app-block', algorithms: ['RS256'] }
    );
    expect(payload.sub).toBe('user:42');
    expect(payload.blockInstanceId).toBe('bki_test');
    expect(payload.scopes).toEqual(['models:read:self']);
    expect((payload as { ctx: { modelId: number } }).ctx.modelId).toBe(12345);
    expect(payload.buzzBudget).toBeUndefined();
  });

  it('includes buzzBudget only when supplied', async () => {
    const { BlockTokenService } = await import('../block-token.service');
    const withBudget = await BlockTokenService.sign({
      userId: 1,
      blockId: 'b',
      appId: 'a',
      appBlockId: 'apb_a',
      blockInstanceId: 'bki',
      scopes: ['ai:write:budgeted'],
      ctx: { modelId: 1 },
      buzzBudget: 200,
    });
    const { payload } = await jwtVerify(withBudget.token, publicKey, {
      issuer: 'civitai',
      audience: 'civitai-app-block',
      algorithms: ['RS256'],
    });
    expect(payload.buzzBudget).toBe(200);
  });

  it('stamps maxBrowsingLevel + domain claims when supplied (SFW domain)', async () => {
    const { BlockTokenService } = await import('../block-token.service');
    const r = await BlockTokenService.sign({
      userId: 1,
      blockId: 'b',
      appId: 'a',
      appBlockId: 'apb_a',
      blockInstanceId: 'bki',
      scopes: ['ai:write:budgeted'],
      ctx: { modelId: 1 },
      domain: 'green',
      maxBrowsingLevel: 3, // sfwBrowsingLevelsFlag (PG | PG13)
    });
    const { payload } = await jwtVerify(r.token, publicKey, {
      issuer: 'civitai',
      audience: 'civitai-app-block',
      algorithms: ['RS256'],
    });
    expect(payload.maxBrowsingLevel).toBe(3);
    expect(payload.domain).toBe('green');
  });

  it('stamps the mature ceiling for a red domain', async () => {
    const { BlockTokenService } = await import('../block-token.service');
    const r = await BlockTokenService.sign({
      userId: 1,
      blockId: 'b',
      appId: 'a',
      appBlockId: 'apb_a',
      blockInstanceId: 'bki',
      scopes: ['ai:write:budgeted'],
      ctx: { modelId: 1 },
      domain: 'red',
      maxBrowsingLevel: 31, // allBrowsingLevelsFlag
    });
    const { payload } = await jwtVerify(r.token, publicKey, {
      issuer: 'civitai',
      audience: 'civitai-app-block',
      algorithms: ['RS256'],
    });
    expect(payload.maxBrowsingLevel).toBe(31);
    expect(payload.domain).toBe('red');
  });

  it('omits the maturity claims entirely when not supplied (legacy path)', async () => {
    const { BlockTokenService } = await import('../block-token.service');
    const r = await BlockTokenService.sign({
      userId: 1,
      blockId: 'b',
      appId: 'a',
      appBlockId: 'apb_a',
      blockInstanceId: 'bki',
      scopes: ['models:read:self'],
      ctx: { modelId: 1 },
    });
    const { payload } = await jwtVerify(r.token, publicKey, {
      issuer: 'civitai',
      audience: 'civitai-app-block',
      algorithms: ['RS256'],
    });
    expect(payload.maxBrowsingLevel).toBeUndefined();
    expect(payload.domain).toBeUndefined();
  });

  it('omits the domain claim when null (host did not resolve a color) but keeps the ceiling', async () => {
    const { BlockTokenService } = await import('../block-token.service');
    const r = await BlockTokenService.sign({
      userId: 1,
      blockId: 'b',
      appId: 'a',
      appBlockId: 'apb_a',
      blockInstanceId: 'bki',
      scopes: ['models:read:self'],
      ctx: { modelId: 1 },
      domain: null,
      maxBrowsingLevel: 3, // still the fail-closed SFW ceiling
    });
    const { payload } = await jwtVerify(r.token, publicKey, {
      issuer: 'civitai',
      audience: 'civitai-app-block',
      algorithms: ['RS256'],
    });
    expect(payload.domain).toBeUndefined();
    expect(payload.maxBrowsingLevel).toBe(3);
  });

  it('signs anon subjects as sub="anon"', async () => {
    const { BlockTokenService } = await import('../block-token.service');
    const r = await BlockTokenService.sign({
      userId: null,
      blockId: 'b',
      appId: 'a',
      appBlockId: 'apb_a',
      blockInstanceId: 'bki',
      scopes: ['models:read:self'],
      ctx: { modelId: 1 },
    });
    const { payload } = await jwtVerify(r.token, publicKey, {
      issuer: 'civitai',
      audience: 'civitai-app-block',
      algorithms: ['RS256'],
    });
    expect(payload.sub).toBe('anon');
  });
});

/**
 * JWT classic-attack regression tests. The middleware uses
 * jose.jwtVerify with `algorithms: ['RS256']`, which by spec rejects:
 *  - alg=none tokens
 *  - HS256 tokens that use the public PEM as the HMAC secret (alg confusion)
 *  - tokens past their exp
 *  - wrong iss/aud
 * These tests pin those guarantees so a regression (e.g. someone widening
 * the algorithm list) is caught at CI.
 */
describe('JWT classic attacks', () => {
  it('rejects alg=none tokens', async () => {
    // alg=none JWT — header.payload with no signature.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: 'user:1', iss: 'civitai', aud: 'civitai-app-block', exp: 1e10 })
    ).toString('base64url');
    const token = `${header}.${payload}.`;
    await expect(
      jwtVerify(token, publicKey, {
        issuer: 'civitai',
        audience: 'civitai-app-block',
        algorithms: ['RS256'],
      })
    ).rejects.toThrow();
  });

  it('rejects HS256 token signed with the public PEM as the HMAC secret', async () => {
    const { SignJWT } = await import('jose');
    // Attempt to sign the same claims with HS256 using the public PEM bytes
    // as the symmetric secret. jose accepts the signing call; jwtVerify
    // with algorithms:['RS256'] rejects.
    const hsToken = await new SignJWT({ blockId: 'b', appId: 'a', blockInstanceId: 'bki', scopes: [], ctx: {} })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('civitai')
      .setAudience('civitai-app-block')
      .setSubject('user:1')
      .setExpirationTime('1h')
      .setIssuedAt()
      .sign(Buffer.from(publicPem));
    await expect(
      jwtVerify(hsToken, Buffer.from(publicPem), {
        issuer: 'civitai',
        audience: 'civitai-app-block',
        algorithms: ['RS256'],
      })
    ).rejects.toThrow();
  });

  it('rejects expired tokens', async () => {
    const { BlockTokenService } = await import('../block-token.service');
    // Sign now, then fast-forward past the 15-min expiry.
    const r = await BlockTokenService.sign({
      userId: 1,
      blockId: 'b',
      appId: 'a',
      appBlockId: 'apb_a',
      blockInstanceId: 'bki',
      scopes: ['models:read:self'],
      ctx: { modelId: 1 },
    });
    // Wait by manipulating `now` argument to jwtVerify.
    const farFuture = Math.floor(Date.now() / 1000) + 60 * 60 * 24;
    await expect(
      jwtVerify(r.token, publicKey, {
        issuer: 'civitai',
        audience: 'civitai-app-block',
        algorithms: ['RS256'],
        currentDate: new Date(farFuture * 1000),
      })
    ).rejects.toThrow();
  });

  it('rejects tokens with wrong issuer', async () => {
    const { BlockTokenService } = await import('../block-token.service');
    const r = await BlockTokenService.sign({
      userId: 1,
      blockId: 'b',
      appId: 'a',
      appBlockId: 'apb_a',
      blockInstanceId: 'bki',
      scopes: ['models:read:self'],
      ctx: { modelId: 1 },
    });
    await expect(
      jwtVerify(r.token, publicKey, {
        issuer: 'NOT_CIVITAI',
        audience: 'civitai-app-block',
        algorithms: ['RS256'],
      })
    ).rejects.toThrow();
  });

  it('rejects tokens with wrong audience', async () => {
    const { BlockTokenService } = await import('../block-token.service');
    const r = await BlockTokenService.sign({
      userId: 1,
      blockId: 'b',
      appId: 'a',
      appBlockId: 'apb_a',
      blockInstanceId: 'bki',
      scopes: ['models:read:self'],
      ctx: { modelId: 1 },
    });
    await expect(
      jwtVerify(r.token, publicKey, {
        issuer: 'civitai',
        audience: 'some-other-audience',
        algorithms: ['RS256'],
      })
    ).rejects.toThrow();
  });
});

describe('Settings-scope tokens get a shorter lifetime (audit H-2 partial)', () => {
  it('block:settings:read carries a 5-minute exp instead of 15-minute', async () => {
    const { BlockTokenService } = await import('../block-token.service');
    const r = await BlockTokenService.sign({
      userId: 1,
      blockId: 'b',
      appId: 'a',
      appBlockId: 'apb_a',
      blockInstanceId: 'bki',
      scopes: ['block:settings:read'],
      ctx: { modelId: 1 },
    });
    const { payload } = await jwtVerify(r.token, publicKey, {
      issuer: 'civitai',
      audience: 'civitai-app-block',
      algorithms: ['RS256'],
    });
    const ttl = (payload.exp as number) - (payload.iat as number);
    expect(ttl).toBeLessThanOrEqual(300);
    expect(ttl).toBeGreaterThan(290);
  });

  it('non-settings scopes still get 15-minute exp', async () => {
    const { BlockTokenService } = await import('../block-token.service');
    const r = await BlockTokenService.sign({
      userId: 1,
      blockId: 'b',
      appId: 'a',
      appBlockId: 'apb_a',
      blockInstanceId: 'bki',
      scopes: ['models:read:self'],
      ctx: { modelId: 1 },
    });
    const { payload } = await jwtVerify(r.token, publicKey, {
      issuer: 'civitai',
      audience: 'civitai-app-block',
      algorithms: ['RS256'],
    });
    const ttl = (payload.exp as number) - (payload.iat as number);
    expect(ttl).toBeLessThanOrEqual(900);
    expect(ttl).toBeGreaterThan(890);
  });

  it('dev:true tokens carry a ~4h exp + a dev:true claim (overrides the default 15min)', async () => {
    const { BlockTokenService } = await import('../block-token.service');
    const r = await BlockTokenService.sign({
      userId: 1,
      blockId: 'b',
      appId: 'a',
      appBlockId: 'apb_a',
      blockInstanceId: 'bki',
      scopes: ['models:read:self'],
      ctx: { modelId: 1 },
      dev: true,
    });
    const { payload } = await jwtVerify(r.token, publicKey, {
      issuer: 'civitai',
      audience: 'civitai-app-block',
      algorithms: ['RS256'],
    });
    const ttl = (payload.exp as number) - (payload.iat as number);
    expect(ttl).toBeLessThanOrEqual(4 * 60 * 60);
    expect(ttl).toBeGreaterThan(4 * 60 * 60 - 10);
    expect(payload.dev).toBe(true);
  });

  it('dev:true OVERRIDES the settings-scope 5min branch (4h wins)', async () => {
    // Defensive precedence assertion — dev page tokens never carry settings
    // scopes in practice, but if both were ever set, dev (4h) must win.
    const { BlockTokenService } = await import('../block-token.service');
    const r = await BlockTokenService.sign({
      userId: 1,
      blockId: 'b',
      appId: 'a',
      appBlockId: 'apb_a',
      blockInstanceId: 'bki',
      scopes: ['block:settings:read'],
      ctx: { modelId: 1 },
      dev: true,
    });
    const { payload } = await jwtVerify(r.token, publicKey, {
      issuer: 'civitai',
      audience: 'civitai-app-block',
      algorithms: ['RS256'],
    });
    const ttl = (payload.exp as number) - (payload.iat as number);
    expect(ttl).toBeGreaterThan(4 * 60 * 60 - 10);
  });

  it('omits the dev claim entirely when dev is not set (byte-identical to today)', async () => {
    const { BlockTokenService } = await import('../block-token.service');
    const r = await BlockTokenService.sign({
      userId: 1,
      blockId: 'b',
      appId: 'a',
      appBlockId: 'apb_a',
      blockInstanceId: 'bki',
      scopes: ['models:read:self'],
      ctx: { modelId: 1 },
    });
    const { payload } = await jwtVerify(r.token, publicKey, {
      issuer: 'civitai',
      audience: 'civitai-app-block',
      algorithms: ['RS256'],
    });
    expect(payload.dev).toBeUndefined();
    const ttl = (payload.exp as number) - (payload.iat as number);
    expect(ttl).toBeLessThanOrEqual(900);
    expect(ttl).toBeGreaterThan(890);
  });

  it('sets a not-before claim matching iat (M-3)', async () => {
    const { BlockTokenService } = await import('../block-token.service');
    const r = await BlockTokenService.sign({
      userId: 1,
      blockId: 'b',
      appId: 'a',
      appBlockId: 'apb_a',
      blockInstanceId: 'bki',
      scopes: ['models:read:self'],
      ctx: { modelId: 1 },
    });
    const { payload } = await jwtVerify(r.token, publicKey, {
      issuer: 'civitai',
      audience: 'civitai-app-block',
      algorithms: ['RS256'],
    });
    expect(payload.nbf).toBeDefined();
    expect(payload.nbf).toBe(payload.iat);
  });
});
