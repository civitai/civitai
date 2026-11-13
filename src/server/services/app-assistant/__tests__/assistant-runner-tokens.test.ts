import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { decodeProtectedHeader, jwtVerify, SignJWT } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import {
  isAssistantRunnerConfigured,
  PREVIEW_GRANT_TTL_SECONDS,
  signRunGrant,
  signRunnerViewerToken,
  verifyRunGrant,
} from '../assistant-runner-tokens';

// TEST-ONLY key pair, generated for this run and never written anywhere.
function testKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey,
    privateKey,
  };
}
const keys = testKeyPair();
const GRANT = { userId: 42, conversationId: 'c-1', idempotencyKey: 'k-1' };

/**
 * What a Restart preview's own calls before its tunnel's start may add to its two waits: listing
 * and opening the app's sandbox, polling it while it starts, the dev server's status, manifest
 * reads and its last probe. The old 2-minute pre-start allowance, less the two waits.
 */
const SETUP_CALLS_ALLOWANCE_MS = 40_000;

/**
 * An `export const` of the runner's, evaluated from its source (the runner and this app share no
 * code): a numeric literal, or a sum of literals and other such constants.
 */
function runnerConstant(name: string): number {
  const root = path.resolve(__dirname, '../../../../..');
  const source = [
    'apps/assistant-runner/src/app-assistant/preview-restart.ts',
    'apps/assistant-runner/src/app-assistant/preview.ts',
    'apps/assistant-runner/src/app-assistant/dev-tunnel.ts',
    'apps/assistant-runner/src/app-assistant/sandbox.ts',
    'apps/assistant-runner/src/minter.ts',
  ]
    .map((file) => readFileSync(path.join(root, file), 'utf8'))
    .join('\n');
  const evaluate = (constant: string): number => {
    const expr = new RegExp(`export const ${constant} =\\s*([^;]+);`).exec(source)?.[1];
    if (!expr) throw new Error(`the runner has no export const ${constant}`);
    return expr
      .split('+')
      .map((term) => term.trim())
      .reduce(
        (sum, term) =>
          sum + (/^[\d_]+$/.test(term) ? Number(term.replace(/_/g, '')) : evaluate(term)),
        0
      );
  };
  return evaluate(name);
}

beforeEach(() => {
  setEnv({
    ASSISTANT_RUNNER_SIGNING_KEY: keys.privatePem,
    ASSISTANT_RUNNER_GRANT_TTL_SECONDS: 7800,
  });
});

// The literal values below are the wire contract the runner verifies (apps/assistant-runner
// `src/tokens.ts`, whose tests sign tokens with these same literals).
describe('the runner’s credentials, as the runner reads them', () => {
  it('signs a run grant ES256, bound to the user, the chat and the start, for the grant TTL', async () => {
    const { token, expiresAt } = await signRunGrant(GRANT);
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'ES256', typ: 'assistant-run-grant+jwt' });
    const { payload } = await jwtVerify(token, keys.publicKey, {
      issuer: 'civitai',
      audience: 'assistant-runner:run-grant',
    });
    expect(payload).toMatchObject({ sub: '42', cid: 'c-1', key: 'k-1' });
    expect(payload.jti).toEqual(expect.any(String));
    expect(payload.exp! - payload.iat!).toBe(7800);
    expect(Date.parse(expiresAt)).toBe(payload.exp! * 1000);
  });

  it('signs a viewer token for five minutes, under its own audience and typ', async () => {
    const { token } = await signRunnerViewerToken(42);
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'ES256', typ: 'assistant-viewer+jwt' });
    const { payload } = await jwtVerify(token, keys.publicKey, {
      issuer: 'civitai',
      audience: 'assistant-runner:viewer',
    });
    expect(payload.sub).toBe('42');
    expect(payload.exp! - payload.iat!).toBe(300);
  });

  it('signs a preview grant: use preview, seven minutes whatever the env says, never subagents', async () => {
    setEnv({ ASSISTANT_RUNNER_GRANT_TTL_SECONDS: 600 });
    const { token } = await signRunGrant({ ...GRANT, use: 'preview', subagents: true });
    const { payload } = await jwtVerify(token, keys.publicKey, {
      issuer: 'civitai',
      audience: 'assistant-runner:run-grant',
    });
    expect(payload).toMatchObject({ sub: '42', cid: 'c-1', key: 'k-1', use: 'preview' });
    expect(payload).not.toHaveProperty('subagents');
    expect(payload.exp! - payload.iat!).toBe(420);
  });

  it('a preview grant is still good at the end of the slowest Restart preview the runner makes', async () => {
    // Every call of a Restart preview is made with this grant: the steps before the tunnel's
    // start (waiting for an app the page just started, then maybe its dev server, plus the
    // sandbox and service calls around them), then the runner's `TUNNEL_START_BUDGET_MS`. The
    // waits and the budget are read from the runner's own source, so raising any of them on that
    // side, or shortening the grant on this one, goes red here. The grant's own life is what is
    // compared: the verify's clock tolerance is for clocks, not part of the budget.
    const setup =
      runnerConstant('RESTART_WAIT_MS') +
      runnerConstant('DEV_SERVER_WAIT_MS') +
      SETUP_CALLS_ALLOWANCE_MS;
    const budget = runnerConstant('TUNNEL_START_BUDGET_MS');
    expect(budget).toBeGreaterThan(0);
    const { token } = await signRunGrant({ ...GRANT, use: 'preview' });
    const { payload } = await jwtVerify(token, keys.publicKey);
    expect((payload.exp! - payload.iat!) * 1000).toBeGreaterThanOrEqual(setup + budget);
    vi.useFakeTimers({ now: Date.now() + setup + budget, toFake: ['Date'] });
    try {
      expect(await verifyRunGrant(token)).toMatchObject({ userId: 42, use: 'preview' });
    } finally {
      vi.useRealTimers();
    }
    // Control: the same grant does run out, past its life and the clock tolerance.
    vi.useFakeTimers({
      now: Date.now() + (PREVIEW_GRANT_TTL_SECONDS + 31) * 1000,
      toFake: ['Date'],
    });
    try {
      expect(await verifyRunGrant(token)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes the grant TTL from the env', async () => {
    setEnv({ ASSISTANT_RUNNER_GRANT_TTL_SECONDS: 600 });
    const { payload } = await jwtVerify((await signRunGrant(GRANT)).token, keys.publicKey);
    expect(payload.exp! - payload.iat!).toBe(600);
  });
});

describe('an unusable signing key', () => {
  it('reads as unconfigured, logged once per value without its contents, not parsed again per call', async () => {
    const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    setEnv({ ASSISTANT_RUNNER_SIGNING_KEY: p384 });
    loggingMock.logToAxiom.mockClear();
    expect(isAssistantRunnerConfigured()).toBe(false);
    expect(isAssistantRunnerConfigured()).toBe(false);
    await expect(signRunGrant(GRANT)).rejects.toThrow(/not configured/);
    const logged = loggingMock.logToAxiom.mock.calls.filter(
      ([entry]) => (entry as { type?: string }).type === 'app-assistant.runner-signing-key.unusable'
    );
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged)).not.toContain('PRIVATE KEY');
  });
});

describe('verifyRunGrant', () => {
  it('reads back a grant civitai signed', async () => {
    const { token } = await signRunGrant(GRANT);
    expect(await verifyRunGrant(token)).toMatchObject({ ...GRANT, grantId: expect.any(String) });
  });

  it('refuses a viewer token presented as a grant (aud confusion)', async () => {
    expect(await verifyRunGrant((await signRunnerViewerToken(42)).token)).toBeNull();
  });

  it('refuses a token carrying every grant claim but the viewer audience or typ, or another issuer', async () => {
    const now = Math.floor(Date.now() / 1000);
    const withClaims = (aud: string, typ: string, iss = 'civitai') =>
      new SignJWT({ cid: 'c-1', key: 'k-1' })
        .setProtectedHeader({ alg: 'ES256', typ })
        .setIssuer(iss)
        .setAudience(aud)
        .setSubject('42')
        .setJti('j')
        .setIssuedAt(now)
        .setExpirationTime(now + 600)
        .sign(keys.privateKey);
    // Control: the same builder with the grant's own values passes, so each refusal below is its field's.
    expect(
      await verifyRunGrant(
        await withClaims('assistant-runner:run-grant', 'assistant-run-grant+jwt')
      )
    ).toMatchObject(GRANT);
    for (const [name, token] of [
      ['viewer aud', await withClaims('assistant-runner:viewer', 'assistant-run-grant+jwt')],
      ['viewer typ', await withClaims('assistant-runner:run-grant', 'assistant-viewer+jwt')],
      ['both viewer', await withClaims('assistant-runner:viewer', 'assistant-viewer+jwt')],
      [
        'another issuer',
        await withClaims('assistant-runner:run-grant', 'assistant-run-grant+jwt', 'elsewhere'),
      ],
    ] as const)
      expect(await verifyRunGrant(token), name).toBeNull();
  });

  it('refuses an expired grant', async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({ cid: 'c-1', key: 'k-1' })
      .setProtectedHeader({ alg: 'ES256', typ: 'assistant-run-grant+jwt' })
      .setIssuer('civitai')
      .setAudience('assistant-runner:run-grant')
      .setSubject('42')
      .setJti('j')
      .setIssuedAt(now - 8000)
      .setExpirationTime(now - 120)
      .sign(keys.privateKey);
    expect(await verifyRunGrant(expired)).toBeNull();
  });

  it('refuses a grant signed with another key', async () => {
    const theirs = testKeyPair();
    setEnv({ ASSISTANT_RUNNER_SIGNING_KEY: theirs.privatePem });
    const forged = (await signRunGrant(GRANT)).token;
    setEnv({ ASSISTANT_RUNNER_SIGNING_KEY: keys.privatePem });
    expect(await verifyRunGrant(forged)).toBeNull();
  });

  it('verifies nothing, and signs nothing, without a key', async () => {
    const { token } = await signRunGrant(GRANT);
    setEnv({ ASSISTANT_RUNNER_SIGNING_KEY: undefined });
    expect(isAssistantRunnerConfigured()).toBe(false);
    expect(await verifyRunGrant(token)).toBeNull();
    await expect(signRunGrant(GRANT)).rejects.toThrow(/not configured/);
    setEnv({ ASSISTANT_RUNNER_SIGNING_KEY: 'not a key' });
    expect(isAssistantRunnerConfigured()).toBe(false);
    // A key that parses but cannot sign ES256 is no key either.
    const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    setEnv({ ASSISTANT_RUNNER_SIGNING_KEY: p384 });
    expect(isAssistantRunnerConfigured()).toBe(false);
  });
});
