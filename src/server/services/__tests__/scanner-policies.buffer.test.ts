import { beforeEach, describe, expect, it, vi } from 'vitest';

// Regression: `isRunCancelled` reads a cancel flag from sysRedis (set to '1' by
// `markRunCancelled`). Pre-fix it compared the reply with `=== '1'`. The
// HA/Sentinel sysRedis returns a Buffer for BLOB_STRING replies, and
// `Buffer === '1'` is always false — so cancellation was silently never
// detected in sentinel mode. Coercing the Buffer to utf8 first restores the
// intended behavior. Mirrors the #2700 buffer-flag test pattern.

const { get } = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock('~/server/redis/client', () => ({
  sysRedis: { get, set: vi.fn(), del: vi.fn() },
  REDIS_SYS_KEYS: { SCANNER_POLICY: { RUN_CANCEL: 'scanner-policy:run-cancel' } },
}));

// Fail-open logger is invoked only in the catch path; keep it inert.
vi.mock('~/server/redis/fail-open-log', () => ({
  logSysRedisFailOpen: vi.fn(),
}));

// The schema module is pure types/zod at runtime; stub to a no-op object so the
// service module loads without dragging in unrelated deps.
vi.mock('~/server/schema/scanner-policies.schema', () => ({
  datasetExportRecordSchema: {},
  scannerPolicyCandidateSchema: {},
}));

import { isRunCancelled } from '~/server/services/scanner-policies.service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isRunCancelled — sysRedis Buffer-vs-string flag', () => {
  it('Buffer("1") is detected as cancelled (was silently false pre-fix)', async () => {
    get.mockResolvedValue(Buffer.from('1', 'utf8'));
    await expect(isRunCancelled('run-a')).resolves.toBe(true);
  });

  it('string "1" is detected as cancelled (legacy single-pod, unchanged)', async () => {
    get.mockResolvedValue('1');
    await expect(isRunCancelled('run-b')).resolves.toBe(true);
  });

  it('Buffer("0") is not cancelled', async () => {
    get.mockResolvedValue(Buffer.from('0', 'utf8'));
    await expect(isRunCancelled('run-c')).resolves.toBe(false);
  });

  it('null (no key) is not cancelled', async () => {
    get.mockResolvedValue(null);
    await expect(isRunCancelled('run-d')).resolves.toBe(false);
  });

  it('an unrelated value is not cancelled', async () => {
    get.mockResolvedValue(Buffer.from('something-else', 'utf8'));
    await expect(isRunCancelled('run-e')).resolves.toBe(false);
  });

  it('a thrown redis error fails open (returns false)', async () => {
    get.mockRejectedValue(new Error('redis down'));
    await expect(isRunCancelled('run-f')).resolves.toBe(false);
  });
});
