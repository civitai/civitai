import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TokenScope } from '@civitai/auth/token-scope';

/**
 * System OAuth apps (owned by the civitai system account, User -1): parsing the register form, creating
 * one, editing one, handing an existing app over, and the admin actions that only touch system apps.
 */

const h = vi.hoisted(() => ({
  // Every write: the table, the values set, and each `.where` as [column, op, value].
  writes: [] as Array<{ table: string; values: unknown; wheres: unknown[][] }>,
  updateResult: { id: 'c1' } as unknown,
  // The row a select finds (moveClientToSystem reads the app first; updateSystemClient after a refusal).
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
  updateSystemClient,
} from '../system-clients';
import { logOAuthEvent } from '$lib/server/oauth/audit-log';
import { actions } from '../../../../routes/admin/access/+page.server';
import { actions as editActions } from '../../../../routes/admin/access/[id]/+page.server';

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
    redirectUris: ['https://app.example/cb'],
  };
  vi.mocked(logOAuthEvent).mockClear();
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

describe('updateSystemClient', () => {
  const details = {
    name: 'Advertising',
    description: 'Ads',
    redirectUris: [
      'https://advertising.civitai.com/auth/callback',
      'http://localhost:5174/auth/callback',
    ],
  };
  const hasWhere = (column: string, value: unknown) =>
    h.writes[0].wheres.some(([col, , v]) => col === column && v === value);
  beforeEach(() => {
    h.client = {
      redirectUris: ['https://advertising.civitai.com/auth/callback', 'http://localhost:5173/cb'],
      allowedOrigins: [
        'https://advertising.civitai.com',
        'http://localhost:5173',
        'https://spa.example.com',
      ],
      skipConsent: false,
    };
  });

  it('moves origins from the old URIs to the new ones, keeping hand-set origins, and logs it', async () => {
    expect(await updateSystemClient('c1', details, 1)).toEqual({ ok: true });
    const allowedOrigins = [
      'https://spa.example.com',
      'https://advertising.civitai.com',
      'http://localhost:5174',
    ];
    expect(h.writes[0]).toMatchObject({
      table: 'OauthClient',
      values: { ...details, allowedOrigins },
    });
    expect(hasWhere('userId', SYSTEM_USER_ID)).toBe(true);
    expect(logOAuthEvent).toHaveBeenCalledWith({
      type: 'client.updated',
      userId: 1,
      clientId: 'c1',
      metadata: {
        owner: 'system',
        name: 'Advertising',
        redirectUris: details.redirectUris,
        allowedOrigins,
      },
    });
  });

  it('writes only onto the row it read, and reports a conflict when that row changed', async () => {
    const current = h.client as { redirectUris: string[]; allowedOrigins: string[] };
    await updateSystemClient('c1', details, 1);
    expect(hasWhere('redirectUris', current.redirectUris)).toBe(true);
    expect(hasWhere('allowedOrigins', current.allowedOrigins)).toBe(true);
    expect(hasWhere('skipConsent', false)).toBe(true);
    h.updateResult = undefined;
    vi.mocked(logOAuthEvent).mockClear();
    expect(await updateSystemClient('c1', details, 1)).toEqual({ conflict: true });
    expect(logOAuthEvent).not.toHaveBeenCalled();
  });

  it('names the URI a skip-consent app may not have, without writing', async () => {
    h.client = { ...(h.client as object), skipConsent: true };
    expect(await updateSystemClient('c1', details, 1)).toEqual({
      refusedRedirectUri: 'http://localhost:5174/auth/callback',
    });
    expect(h.writes).toHaveLength(0);
  });

  it('returns null for an app that is not a system app, or an App-Block client', async () => {
    h.client = undefined;
    expect(await updateSystemClient('c1', details, 1)).toBeNull();
    expect(await updateSystemClient('appblk-game', details, 1)).toBeNull();
    expect(h.writes).toHaveLength(0);
  });
});

describe('/admin/access/[id] edit', () => {
  const save = (fields: Record<string, string>) =>
    (editActions.default as (e: unknown) => Promise<unknown>)({
      params: { id: 'c1' },
      request: new Request('https://auth.example.test/admin/access/c1', {
        method: 'POST',
        body: formData(fields),
      }),
      locals: { user: { id: 1 } },
    });
  beforeEach(() => {
    h.client = { redirectUris: ['https://ads.example/cb'], allowedOrigins: [], skipConsent: false };
  });

  it('saves a valid form', async () => {
    expect(
      await save({ name: 'Ads', redirectUris: 'https://ads.example/cb\nhttps://ads.example/cb2' })
    ).toEqual({ success: true });
    expect(h.writes[0].values).toMatchObject({
      name: 'Ads',
      description: '',
      redirectUris: ['https://ads.example/cb', 'https://ads.example/cb2'],
    });
  });

  it('refuses an invalid form without writing', async () => {
    expect(await save({ name: 'Ads', redirectUris: 'http://ads.example/cb' })).toMatchObject({
      status: 400,
    });
    expect(h.writes).toHaveLength(0);
  });

  it('says which URI is refused, that the app changed, or that it is gone', async () => {
    h.client = { ...(h.client as object), skipConsent: true };
    expect(await save({ name: 'Ads', redirectUris: 'http://localhost:5174/cb' })).toMatchObject({
      status: 400,
      data: { error: expect.stringContaining('http://localhost:5174/cb') },
    });
    h.updateResult = undefined;
    expect(await save({ name: 'Ads', redirectUris: 'https://ads.example/cb' })).toMatchObject({
      status: 409,
    });
    h.client = undefined;
    expect(await save({ name: 'Ads', redirectUris: 'https://ads.example/cb' })).toMatchObject({
      status: 404,
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

  it('refuses to move an app that skips consent while it has an http or loopback redirect', async () => {
    h.client = {
      isConfidential: true,
      grants: ['authorization_code'],
      skipConsent: true,
      redirectUris: ['https://app.example/cb', 'http://localhost:3000/cb'],
    };
    expect(await moveClientToSystem('c1', 1)).toEqual({
      refusedRedirectUri: 'http://localhost:3000/cb',
    });
    expect(h.writes).toHaveLength(0);
  });

  it('moves an app that skips consent when every redirect is https off loopback', async () => {
    h.client = { ...(h.client as object), skipConsent: true };
    expect(await moveClientToSystem('c1', 1)).toEqual({ clientSecret: 'the-secret' });
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

  it('turns skip consent on only while the redirect URIs are the ones it checked', async () => {
    await run('setSkipConsent', { id: 'c1', skipConsent: 'true' });
    expect(hasWhere('redirectUris', (h.client as { redirectUris: string[] }).redirectUris)).toBe(
      true
    );
  });

  it.each([
    'http://app.example/cb',
    'https://localhost/cb',
    'https://127.0.0.1:8443/cb',
    'https://[::1]/cb',
  ])('refuses to turn on skip consent while %s is registered', async (uri) => {
    h.client = { redirectUris: ['https://app.example/cb', uri] };
    expect(await run('setSkipConsent', { id: 'c1', skipConsent: 'true' })).toMatchObject({
      status: 400,
      data: { error: expect.stringContaining(uri) },
    });
    expect(h.writes).toHaveLength(0);
  });

  it('shows which redirect blocks moving an app that skips consent', async () => {
    h.client = {
      isConfidential: true,
      grants: [],
      skipConsent: true,
      redirectUris: ['http://a.example/cb'],
    };
    expect(await run('moveToSystem', { id: 'c1' })).toMatchObject({
      status: 400,
      data: { error: expect.stringContaining('http://a.example/cb') },
    });
    expect(h.writes).toHaveLength(0);
  });

  it('logs who changed skip consent or the token limit, on which app, to what', async () => {
    await run('setSkipConsent', { id: 'c1', skipConsent: 'true' });
    await run('setTokenRateLimit', { id: 'c1', tokenRateLimit: '1000' });
    expect(vi.mocked(logOAuthEvent).mock.calls.map(([e]) => e)).toEqual([
      {
        type: 'client.updated',
        userId: 1,
        clientId: 'c1',
        metadata: { owner: 'system', skipConsent: true },
      },
      {
        type: 'client.updated',
        userId: 1,
        clientId: 'c1',
        metadata: { owner: 'system', tokenRateLimit: 1000 },
      },
    ]);
  });

  it('logs nothing when the app is not found', async () => {
    h.updateResult = undefined;
    await run('setTokenRateLimit', { id: 'c1', tokenRateLimit: '' });
    expect(logOAuthEvent).not.toHaveBeenCalled();
  });
});
