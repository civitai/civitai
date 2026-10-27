import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TokenScope } from '@civitai/auth/token-scope';

/**
 * System OAuth apps (owned by the civitai system account, User -1): parsing the register form, creating
 * one, handing an existing app over, and the admin actions that only touch system apps.
 */

const h = vi.hoisted(() => ({
  // Every write: the table, the values set, and each `.where` as [column, op, value].
  writes: [] as Array<{ table: string; values: unknown; wheres: unknown[][] }>,
  updateResult: { id: 'c1' } as unknown,
  // The row a select finds (moveClientToSystem reads the app first).
  client: undefined as unknown,
}));

vi.mock('$lib/server/db/db', () => {
  const writer = (table: string) => {
    const w = { table, values: undefined as unknown, wheres: [] as unknown[][] };
    h.writes.push(w);
    const qb: Record<string, unknown> = {};
    qb.values = (v: unknown) => ((w.values = v), qb);
    qb.set = (v: unknown) => ((w.values = v), qb);
    qb.where = (...args: unknown[]) => (w.wheres.push(args), qb);
    qb.returning = () => qb;
    qb.execute = async () => [];
    qb.executeTakeFirst = async () => h.updateResult;
    return qb;
  };
  const reader = () => {
    const qb: Record<string, unknown> = {};
    qb.select = () => qb;
    qb.where = () => qb;
    qb.executeTakeFirst = async () => h.client;
    return qb;
  };
  return { db: { insertInto: writer, updateTable: writer, selectFrom: reader } };
});
vi.mock('$lib/server/oauth/audit-log', () => ({ logOAuthEvent: vi.fn() }));
vi.mock('@civitai/auth/secret-hash', () => ({
  generateSecretHash: (s: string) => `hash:${s}`,
  generateKey: () => 'the-secret',
}));

import {
  SYSTEM_USER_ID,
  createSystemClient,
  moveClientToSystem,
  parseSystemClientInput,
} from '../system-clients';
import { actions } from '../../../../routes/admin/access/+page.server';

const formData = (fields: Record<string, string | string[]>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const one of [v].flat()) fd.append(k, one);
  return fd;
};

beforeEach(() => {
  h.writes.length = 0;
  h.updateResult = { id: 'c1' };
  h.client = {
    isConfidential: true,
    grants: ['authorization_code', 'refresh_token', 'client_credentials'],
  };
});

describe('parseSystemClientInput', () => {
  it('reads the form, always granting UserRead', () => {
    const input = parseSystemClientInput(
      formData({
        name: ' Advertising ',
        redirectUris:
          'https://advertising.civitai.com/auth/callback\nhttp://localhost:5174/auth/callback',
        isConfidential: 'true',
        scope: String(TokenScope.UserWrite),
      })
    );
    expect(input).toEqual({
      name: 'Advertising',
      description: '',
      redirectUris: [
        'https://advertising.civitai.com/auth/callback',
        'http://localhost:5174/auth/callback',
      ],
      isConfidential: true,
      allowedScopes: TokenScope.UserRead | TokenScope.UserWrite,
    });
  });

  it('refuses http off loopback, fragments, a missing name and unknown scopes', () => {
    const base = { name: 'x', redirectUris: 'https://a.example/cb' };
    for (const fields of [
      { ...base, redirectUris: 'http://a.example/cb' },
      { ...base, redirectUris: 'https://a.example/cb#x' },
      { ...base, redirectUris: 'not a url' },
      { ...base, redirectUris: '' },
      { ...base, name: '' },
      { ...base, scope: String(TokenScope.WorkerRegister) },
    ]) {
      expect(parseSystemClientInput(formData(fields))).toHaveProperty('error');
    }
  });
});

describe('createSystemClient', () => {
  it('registers the app to the system account, storing only the secret hash', async () => {
    const { clientId, clientSecret } = await createSystemClient(
      {
        name: 'Advertising',
        description: '',
        redirectUris: ['https://advertising.civitai.com/auth/callback'],
        isConfidential: true,
        allowedScopes: TokenScope.UserRead,
      },
      1
    );
    expect(clientSecret).toBe('the-secret');
    expect(h.writes[0]).toMatchObject({
      table: 'OauthClient',
      values: {
        id: clientId,
        secret: 'hash:the-secret',
        userId: SYSTEM_USER_ID,
        allowedOrigins: ['https://advertising.civitai.com'],
        isVerified: true,
      },
    });
  });
});

describe('moveClientToSystem', () => {
  it('hands a confidential app over with a new secret and without client_credentials', async () => {
    // client_credentials would let the app act as the system account; the old secret is its developer's.
    expect(await moveClientToSystem('c1', 1)).toEqual({ clientSecret: 'the-secret' });
    expect(h.writes[0]).toMatchObject({
      table: 'OauthClient',
      values: {
        userId: SYSTEM_USER_ID,
        secret: 'hash:the-secret',
        grants: ['authorization_code', 'refresh_token'],
      },
    });
  });

  it('hands a public app over with no secret', async () => {
    h.client = { isConfidential: false, grants: ['authorization_code'] };
    expect(await moveClientToSystem('c1', 1)).toEqual({ clientSecret: null });
    expect(h.writes[0].values).not.toHaveProperty('secret');
  });

  it('does nothing for an app that is already a system app or gone', async () => {
    h.client = undefined;
    expect(await moveClientToSystem('c1', 1)).toBeNull();
    expect(h.writes).toHaveLength(0);
  });

  it('never moves an App-Block client', async () => {
    expect(await moveClientToSystem('appblk-game', 1)).toBeNull();
    expect(h.writes).toHaveLength(0);
  });
});

describe('/admin/access actions', () => {
  const run = (action: keyof typeof actions, fields: Record<string, string>) =>
    (actions[action] as (e: unknown) => Promise<unknown>)({
      request: new Request('https://auth.example.test/admin/access', {
        method: 'POST',
        body: formData(fields),
      }),
      locals: { user: { id: 1 } },
    });
  const hasWhere = (column: string, value: unknown) =>
    h.writes[0].wheres.some(([col, , v]) => col === column && v === value);
  const systemOnly = () => hasWhere('userId', SYSTEM_USER_ID);
  const confidentialOnly = () => hasWhere('isConfidential', true);

  it('only turns on skip consent or a token limit for a confidential system app', async () => {
    await run('setSkipConsent', { id: 'c1', skipConsent: 'true' });
    expect(systemOnly() && confidentialOnly()).toBe(true);
    h.writes.length = 0;
    await run('setTokenRateLimit', { id: 'c1', tokenRateLimit: '1000' });
    expect(systemOnly() && confidentialOnly()).toBe(true);
  });

  it('lets either be turned off on any system app, public ones included', async () => {
    await run('setSkipConsent', { id: 'c1', skipConsent: 'false' });
    expect(systemOnly() && !confidentialOnly()).toBe(true);
    h.writes.length = 0;
    await run('setTokenRateLimit', { id: 'c1', tokenRateLimit: '' });
    expect(systemOnly() && !confidentialOnly()).toBe(true);
  });

  it('refuses those settings for an app that is not a confidential system app', async () => {
    h.updateResult = undefined;
    expect(await run('setSkipConsent', { id: 'c1', skipConsent: 'true' })).toMatchObject({
      status: 404,
      data: { error: expect.stringContaining('confidential') },
    });
  });

  it('changes access mode on any app', async () => {
    await run('setMode', { id: 'c1', accessMode: 'testers' });
    expect(systemOnly()).toBe(false);
  });

  it('refuses a token limit that is not a whole number from 1 to 100,000', async () => {
    for (const tokenRateLimit of ['0', '-5', '1.5', 'abc', '100001']) {
      expect(await run('setTokenRateLimit', { id: 'c1', tokenRateLimit })).toMatchObject({
        status: 400,
      });
    }
    expect(h.writes).toHaveLength(0);
  });

  it('clears the token limit when left blank', async () => {
    await run('setTokenRateLimit', { id: 'c1', tokenRateLimit: '' });
    expect(h.writes[0].values).toEqual({ tokenRateLimit: null });
  });
});
