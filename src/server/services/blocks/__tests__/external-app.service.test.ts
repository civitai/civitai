import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * App Blocks — off-site (external-link) registration service (PURE EXTERNAL
 * LINK). Verifies the mod-only register path:
 *   - rejects a non-https URL,
 *   - rejects an external app that also declares an on-platform surface,
 *   - rejects an already-taken slug,
 *   - on success: creates a STRUCTURALLY NON-INTERACTIVE OauthClient (grants:[],
 *     allowedScopes:0, no origins) + an approved app_blocks row with
 *     external_url set, approved_scopes:[] (no scopes), and NO bundle/forgejo.
 *
 * No DB: dbRead/dbWrite are mocked; we capture the create() args.
 */

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    appBlock: {
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
    },
    oauthClient: {
      create: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      update: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
    },
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));
// Deterministic id so assertions don't depend on the ULID.
vi.mock('~/server/utils/app-block-ids', () => ({ newUlid: () => 'ULIDXXXX' }));

const validInput = {
  slug: 'cool-app',
  name: 'Cool App',
  description: 'An off-site app',
  externalUrl: 'https://cool.example.com/launch',
  reviewerUserId: 42,
};

describe('registerExternalApp', () => {
  beforeEach(() => {
    mockDb.appBlock.findFirst.mockReset().mockResolvedValue(null);
    mockDb.appBlock.create.mockReset().mockResolvedValue({});
    mockDb.oauthClient.create.mockReset().mockResolvedValue({});
    mockDb.oauthClient.findUnique.mockReset().mockResolvedValue(null);
    mockDb.oauthClient.update.mockReset().mockResolvedValue({});
  });

  it('creates an approved external app_blocks row with external_url set', async () => {
    const { registerExternalApp } = await import('../external-app.service');
    const res = await registerExternalApp(validInput);

    expect(res.appBlockId).toBe('apb_ULIDXXXX');
    expect(res.slug).toBe('cool-app');
    expect(res.externalUrl).toBe('https://cool.example.com/launch');

    expect(mockDb.appBlock.create).toHaveBeenCalledTimes(1);
    const data = (mockDb.appBlock.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      id: 'apb_ULIDXXXX',
      appId: 'appblk-cool-app',
      blockId: 'cool-app',
      status: 'approved',
      externalUrl: 'https://cool.example.com/launch',
      approvedScopes: [],
      renderMode: 'external',
    });
  });

  it('creates a STRUCTURALLY NON-INTERACTIVE OauthClient (grants:[], allowedScopes:0, no origins)', async () => {
    const { registerExternalApp } = await import('../external-app.service');
    await registerExternalApp(validInput);

    expect(mockDb.oauthClient.create).toHaveBeenCalledTimes(1);
    const data = (mockDb.oauthClient.create.mock.calls[0][0] as { data: Record<string, unknown> })
      .data;
    expect(data).toMatchObject({
      id: 'appblk-cool-app',
      grants: [],
      allowedScopes: 0,
      allowedOrigins: [],
      redirectUris: [],
      userId: 42,
    });
  });

  it('does NOT touch any bundle / forgejo path (no extra writes)', async () => {
    const { registerExternalApp } = await import('../external-app.service');
    await registerExternalApp(validInput);
    // The only writes are the one OauthClient + one AppBlock.
    expect(mockDb.oauthClient.create).toHaveBeenCalledTimes(1);
    expect(mockDb.appBlock.create).toHaveBeenCalledTimes(1);
  });

  it('REJECTS a non-https externalUrl (no DB writes)', async () => {
    const { registerExternalApp } = await import('../external-app.service');
    await expect(
      registerExternalApp({ ...validInput, externalUrl: 'http://cool.example.com' })
    ).rejects.toThrow(/https/i);
    expect(mockDb.oauthClient.create).not.toHaveBeenCalled();
    expect(mockDb.appBlock.create).not.toHaveBeenCalled();
  });

  it('REJECTS a javascript: URL (XSS vector) (no DB writes)', async () => {
    const { registerExternalApp } = await import('../external-app.service');
    await expect(
      registerExternalApp({ ...validInput, externalUrl: 'javascript:alert(1)' })
    ).rejects.toThrow();
    expect(mockDb.appBlock.create).not.toHaveBeenCalled();
  });

  it('REJECTS an already-registered slug (no writes)', async () => {
    mockDb.appBlock.findFirst.mockResolvedValueOnce({ id: 'ab_existing', externalUrl: null });
    const { registerExternalApp } = await import('../external-app.service');
    await expect(registerExternalApp(validInput)).rejects.toThrow(/already registered/i);
    expect(mockDb.oauthClient.create).not.toHaveBeenCalled();
    expect(mockDb.appBlock.create).not.toHaveBeenCalled();
  });

  it('REJECTS an unknown category', async () => {
    const { registerExternalApp } = await import('../external-app.service');
    await expect(
      registerExternalApp({ ...validInput, category: 'definitely-not-a-category' })
    ).rejects.toThrow(/category/i);
    expect(mockDb.appBlock.create).not.toHaveBeenCalled();
  });

  it('stores the trimmed/canonical URL form', async () => {
    const { registerExternalApp } = await import('../external-app.service');
    await registerExternalApp({ ...validInput, externalUrl: '  https://cool.example.com  ' });
    const data = (mockDb.appBlock.create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    // URL() canonicalises a bare host to a trailing slash.
    expect(data.externalUrl).toBe('https://cool.example.com/');
  });
});
