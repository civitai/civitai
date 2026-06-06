import { beforeEach, describe, expect, it, vi } from 'vitest';

// The repo's slim-generated Prisma client does not expose the error constructors
// at runtime, so we model the shapes (name / code / message) the engine emits.
function prismaError({ name, code, message }: { name?: string; code?: string; message?: string }) {
  const err = new Error(message ?? name ?? code ?? 'error');
  if (name) err.name = name;
  if (code) (err as Error & { code?: string }).code = code;
  return err;
}

// db-lag-helpers reads env at module load and imports flipt/redis transitively;
// stub the side-effectful dependencies so the unit under test is isolated.
const { mockDbRead, mockDbWrite, mockFallbackInc } = vi.hoisted(() => ({
  mockDbRead: { tag: 'read' } as unknown as Record<string, unknown>,
  mockDbWrite: { tag: 'write' } as unknown as Record<string, unknown>,
  mockFallbackInc: vi.fn(),
}));

vi.mock('~/env/server', () => ({
  env: { REPLICATION_LAG_DELAY: 0 },
}));
vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/db/notifDb', () => ({ notifDbRead: {}, notifDbWrite: {} }));
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { HIGH_REPLICATION_LAG_MODE: 'high-replication-lag-mode' },
  isFliptSync: () => false,
}));
vi.mock('~/server/redis/client', () => ({
  redis: { get: vi.fn(), set: vi.fn() },
  REDIS_KEYS: { LAG_HELPER: 'lag-helper' },
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/prom/client', () => ({
  dbReadFallbackCounter: { inc: mockFallbackInc },
}));

import { isDbConnectionError, readWithReplicaFallback } from '~/server/db/db-lag-helpers';

describe('isDbConnectionError', () => {
  it('treats PrismaClientInitializationError as a connection error', () => {
    const err = prismaError({ name: 'PrismaClientInitializationError', message: 'cannot reach db' });
    expect(isDbConnectionError(err)).toBe(true);
    expect(
      isDbConnectionError(prismaError({ name: 'PrismaClientRustPanicError', message: 'panic' }))
    ).toBe(true);
  });

  it('treats known connection error codes as connection errors', () => {
    for (const code of ['P1001', 'P1002', 'P1008', 'P1017', 'P2024']) {
      const err = prismaError({ name: 'PrismaClientKnownRequestError', code, message: 'conn' });
      expect(isDbConnectionError(err)).toBe(true);
    }
  });

  it('treats the incident "kind: Closed" socket message as a connection error', () => {
    expect(isDbConnectionError(new Error('PostgreSQL connection: Error { kind: Closed }'))).toBe(
      true
    );
    expect(isDbConnectionError(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isDbConnectionError(new Error('connect ECONNREFUSED 10.0.0.1:6432'))).toBe(true);
  });

  it('does NOT treat genuine query errors (e.g. unique violation) as connection errors', () => {
    const err = prismaError({
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
      message: 'unique constraint',
    });
    expect(isDbConnectionError(err)).toBe(false);
  });

  it('does not misclassify arbitrary errors', () => {
    expect(isDbConnectionError(new Error('relation does not exist'))).toBe(false);
    expect(isDbConnectionError(undefined)).toBe(false);
    expect(isDbConnectionError('boom')).toBe(false);
  });
});

describe('readWithReplicaFallback', () => {
  beforeEach(() => {
    mockFallbackInc.mockClear();
  });

  it('reads from the replica (RO) connection on the happy path', async () => {
    const read = vi.fn(async (db: unknown) => (db === mockDbRead ? 'ro-result' : 'rw-result'));

    const result = await readWithReplicaFallback(read as never, {
      entity: 'userMultiplier',
      caller: 'test',
    });

    expect(result).toBe('ro-result');
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(mockDbRead);
    expect(mockFallbackInc).not.toHaveBeenCalled();
  });

  it('falls back to the primary (RW) connection on a connection-level failure', async () => {
    const connErr = new Error('PostgreSQL connection: Error { kind: Closed }');
    const read = vi.fn(async (db: unknown) => {
      if (db === mockDbRead) throw connErr;
      return 'rw-result';
    });

    const result = await readWithReplicaFallback(read as never, {
      entity: 'userMultiplier',
      caller: 'test',
    });

    expect(result).toBe('rw-result');
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenNthCalledWith(1, mockDbRead);
    expect(read).toHaveBeenNthCalledWith(2, mockDbWrite);
    expect(mockFallbackInc).toHaveBeenCalledWith({ entity: 'userMultiplier', caller: 'test' });
  });

  it('rethrows genuine query errors without falling back', async () => {
    const queryErr = prismaError({
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
      message: 'unique',
    });
    const read = vi.fn(async (db: unknown) => {
      if (db === mockDbRead) throw queryErr;
      return 'rw-result';
    });

    await expect(
      readWithReplicaFallback(read as never, { entity: 'userMultiplier', caller: 'test' })
    ).rejects.toBe(queryErr);
    expect(read).toHaveBeenCalledTimes(1);
    expect(mockFallbackInc).not.toHaveBeenCalled();
  });
});
