import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the AppStorageProvisioner. Focus is on the contract with
 * the pg client (idempotent DDL, txn boundaries, slug validation) — the
 * actual SQL is exercised end-to-end in a per-PR integration smoke that
 * lives outside this fast unit suite.
 */

const { mockClient, mockPool, capturedQueries } = vi.hoisted(() => {
  type Capture = { sql: string; params?: unknown[] };
  const capturedQueries: Capture[] = [];
  const mockClient = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      capturedQueries.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  const mockPool = {
    connect: vi.fn(async () => mockClient),
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  };
  return { mockClient, mockPool, capturedQueries };
});

vi.mock('~/server/db/appsDb', () => ({
  requireAppsDb: () => mockPool,
}));

import { AppStorageProvisioner } from '../storage-provision.service';

beforeEach(() => {
  mockClient.query.mockClear();
  mockClient.release.mockClear();
  mockPool.connect.mockClear();
  mockPool.query.mockClear();
  capturedQueries.length = 0;
});

describe('AppStorageProvisioner.provision', () => {
  it('rejects an invalid slug before touching the pool', async () => {
    await expect(
      AppStorageProvisioner.provision({ appBlockId: 'apb_x', slug: 'bad-slug' })
    ).rejects.toThrow(/invalid slug/);
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('rejects an empty appBlockId', async () => {
    await expect(
      AppStorageProvisioner.provision({ appBlockId: '', slug: 'generate_from_model' })
    ).rejects.toThrow(/appBlockId required/);
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('wraps DDL in a transaction and releases the client', async () => {
    await AppStorageProvisioner.provision({
      appBlockId: 'apb_test',
      slug: 'generate_from_model',
    });
    const sqlLines = capturedQueries.map((q) => q.sql.trim().split('\n')[0]);
    expect(sqlLines[0]).toBe('BEGIN');
    expect(sqlLines[sqlLines.length - 1]).toBe('COMMIT');
    expect(mockClient.release).toHaveBeenCalledOnce();
  });

  it('issues every DDL statement with the quoted per-slug identifier', async () => {
    await AppStorageProvisioner.provision({
      appBlockId: 'apb_test',
      slug: 'generate_from_model',
    });
    const joined = capturedQueries.map((q) => q.sql).join('\n');
    expect(joined).toContain('"app_generate_from_model"');
    expect(joined).toContain('"app_generate_from_model_role"');
    // Spot-check the core shape lands
    expect(joined).toContain('CREATE SCHEMA IF NOT EXISTS "app_generate_from_model"');
    expect(joined).toContain('CREATE TABLE IF NOT EXISTS "app_generate_from_model".kv');
    expect(joined).toContain('CREATE TABLE IF NOT EXISTS "app_generate_from_model".quota');
    expect(joined).toContain('CREATE OR REPLACE FUNCTION "app_generate_from_model".kv_quota_trigger()');
    expect(joined).toContain('CREATE TRIGGER kv_quota_trg');
  });

  it('provisions the SHARED storage tables + trigger (shared_kv/votes/counters/reports)', async () => {
    await AppStorageProvisioner.provision({
      appBlockId: 'apb_test',
      slug: 'generate_from_model',
    });
    const joined = capturedQueries.map((q) => q.sql).join('\n');
    const S = '"app_generate_from_model"';
    // shared_kv: server-key PK, author, generated size_bytes, hidden columns.
    expect(joined).toContain(`CREATE TABLE IF NOT EXISTS ${S}.shared_kv`);
    expect(joined).toContain('key text PRIMARY KEY');
    expect(joined).toContain('author_user_id integer NOT NULL');
    expect(joined).toContain('hidden_at timestamptz');
    // votes: composite PK (one-vote-per-user) + FK cascade.
    expect(joined).toContain(`CREATE TABLE IF NOT EXISTS ${S}.votes`);
    expect(joined).toContain(`REFERENCES ${S}.shared_kv(key) ON DELETE CASCADE`);
    expect(joined).toContain('PRIMARY KEY (key, user_id)');
    // counters: CHECK(count>=0) blocks underflow (H1) + FK cascade.
    expect(joined).toContain(`CREATE TABLE IF NOT EXISTS ${S}.counters`);
    expect(joined).toContain('CHECK (count >= 0)');
    // reports table (M4/M5).
    expect(joined).toContain(`CREATE TABLE IF NOT EXISTS ${S}.shared_kv_reports`);
    // shared_kv reuses the quota trigger fn → shared bytes/rows fold into the quota.
    expect(joined).toContain('CREATE TRIGGER shared_kv_quota_trg');
    expect(joined).toContain(`EXECUTE FUNCTION ${S}.kv_quota_trigger()`);
  });

  it('seeds the quota row with the provided appBlockId via a parameterized insert', async () => {
    await AppStorageProvisioner.provision({
      appBlockId: 'apb_seed_value',
      slug: 'generate_from_model',
    });
    const insert = capturedQueries.find((q) =>
      q.sql.includes('INSERT INTO "app_generate_from_model".quota')
    );
    expect(insert).toBeDefined();
    expect(insert?.params).toEqual(['apb_seed_value']);
    expect(insert?.sql).toContain('ON CONFLICT (app_block_id) DO NOTHING');
  });

  it('rolls back when a statement throws + still releases the client', async () => {
    let nth = 0;
    mockClient.query.mockImplementation(async (sql: string) => {
      nth++;
      // The service emits this DDL as an indented template literal, so the SQL
      // string has leading whitespace — match on the trimmed text, not startsWith
      // on the raw string (which silently never matched, so the mock never threw
      // and provision() wrongly resolved instead of rejecting).
      if (sql.trimStart().startsWith('CREATE TABLE IF NOT EXISTS "app_generate_from_model".kv')) {
        throw new Error('boom');
      }
      capturedQueries.push({ sql });
      return { rows: [], rowCount: 0 };
    });

    await expect(
      AppStorageProvisioner.provision({
        appBlockId: 'apb_test',
        slug: 'generate_from_model',
      })
    ).rejects.toThrow(/boom/);
    expect(capturedQueries.map((q) => q.sql.trim().split('\n')[0])).toContain('ROLLBACK');
    expect(mockClient.release).toHaveBeenCalledOnce();
    expect(nth).toBeGreaterThan(0);
  });
});

describe('AppStorageProvisioner.deprovision', () => {
  it('rejects an invalid slug', async () => {
    await expect(
      AppStorageProvisioner.deprovision({ slug: '!!' })
    ).rejects.toThrow(/invalid slug/);
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('drops schema + role inside a transaction', async () => {
    await AppStorageProvisioner.deprovision({ slug: 'generate_from_model' });
    const sqls = capturedQueries.map((q) => q.sql);
    expect(sqls.some((s) => s.startsWith('BEGIN'))).toBe(true);
    expect(sqls.some((s) => s.startsWith('COMMIT'))).toBe(true);
    expect(sqls.some((s) => s.includes('DROP SCHEMA IF EXISTS "app_generate_from_model" CASCADE'))).toBe(true);
    expect(sqls.some((s) => s.includes('DROP ROLE "app_generate_from_model_role"'))).toBe(true);
    expect(mockClient.release).toHaveBeenCalledOnce();
  });
});

describe('AppStorageProvisioner.provisionReviewPreview (#2831)', () => {
  it('rejects an invalid publishRequestId before touching the pool', async () => {
    await expect(
      AppStorageProvisioner.provisionReviewPreview({ publishRequestId: '!!' })
    ).rejects.toThrow(/invalid publishRequestId/);
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('provisions the DISPOSABLE apprev_ schema (per-user KV only) keyed on the publishRequestId', async () => {
    // Default mockPool.query → schema does not exist → the DDL runs.
    const { schema } = await AppStorageProvisioner.provisionReviewPreview({
      publishRequestId: 'pubreq_abc',
    });
    expect(schema).toBe('"apprev_pubreqabc"');
    const sqls = capturedQueries.map((q) => q.sql);
    expect(sqls.some((s) => s.startsWith('BEGIN'))).toBe(true);
    expect(sqls.some((s) => s.startsWith('COMMIT'))).toBe(true);
    expect(sqls.some((s) => s.includes('CREATE SCHEMA IF NOT EXISTS "apprev_pubreqabc"'))).toBe(true);
    expect(sqls.some((s) => s.includes('CREATE TABLE IF NOT EXISTS "apprev_pubreqabc".kv'))).toBe(true);
    expect(sqls.some((s) => s.includes('"apprev_pubreqabc".quota'))).toBe(true);
    expect(sqls.some((s) => s.includes('kv_quota_trigger'))).toBe(true);
    // The quota seed row is keyed on the publishRequestId. Read the args from
    // mock.calls (records the real 2nd arg regardless of any leaked impl).
    const seedCall = mockClient.query.mock.calls.find(
      (c) => String(c[0]).includes('INSERT INTO') && String(c[0]).includes('.quota')
    );
    expect(String(seedCall?.[0])).toContain('"apprev_pubreqabc".quota');
    expect(seedCall?.[1]).toEqual(['pubreq_abc']);
    // NEVER the approved app schema, and NEVER the cross-user / role surfaces.
    expect(sqls.some((s) => s.includes('"app_'))).toBe(false);
    expect(sqls.some((s) => s.includes('shared_kv'))).toBe(false);
    expect(sqls.some((s) => s.includes('votes'))).toBe(false);
    expect(sqls.some((s) => s.includes('CREATE ROLE'))).toBe(false);
    expect(mockClient.release).toHaveBeenCalledOnce();
  });

  it('FAST-PATHs (no DDL) when the preview schema already exists', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ exists: true }], rowCount: 1 });
    const { schema } = await AppStorageProvisioner.provisionReviewPreview({
      publishRequestId: 'pubreq_abc',
    });
    expect(schema).toBe('"apprev_pubreqabc"');
    // Existing schema → the DDL transaction is skipped entirely.
    expect(mockPool.connect).not.toHaveBeenCalled();
    expect(capturedQueries).toHaveLength(0);
  });
});

describe('AppStorageProvisioner.deprovisionReviewPreview (#2831)', () => {
  it('rejects an invalid publishRequestId', async () => {
    await expect(
      AppStorageProvisioner.deprovisionReviewPreview({ publishRequestId: '!!' })
    ).rejects.toThrow(/invalid publishRequestId/);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  it('DROPs the disposable preview schema CASCADE (no role to reclaim)', async () => {
    await AppStorageProvisioner.deprovisionReviewPreview({ publishRequestId: 'pubreq_abc' });
    const poolSqls = mockPool.query.mock.calls.map((c) => String(c[0]));
    expect(poolSqls.some((s) => s.includes('DROP SCHEMA IF EXISTS "apprev_pubreqabc" CASCADE'))).toBe(
      true
    );
    // A preview schema has no per-app role.
    expect(poolSqls.some((s) => s.includes('DROP ROLE'))).toBe(false);
  });
});

describe('AppStorageProvisioner.getQuota', () => {
  it('returns null when the schema has not been provisioned', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [{ exists: false }], rowCount: 1 });

    const result = await AppStorageProvisioner.getQuota({
      appBlockId: 'apb_test',
      slug: 'generate_from_model',
    });
    expect(result).toBeNull();
  });

  it('returns a zero quota when the schema exists but the seed row is missing', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ exists: true }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await AppStorageProvisioner.getQuota({
      appBlockId: 'apb_test',
      slug: 'generate_from_model',
    });
    expect(result).toEqual({ usedBytes: 0, rowCount: 0 });
  });

  it('coerces bigint text to number', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ exists: true }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ used_bytes: '12345', row_count: '7' }],
        rowCount: 1,
      });

    const result = await AppStorageProvisioner.getQuota({
      appBlockId: 'apb_test',
      slug: 'generate_from_model',
    });
    expect(result).toEqual({ usedBytes: 12345, rowCount: 7 });
  });
});
