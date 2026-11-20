import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaClients } from '@civitai/db/client';

/**
 * The `$on` wiring through real PrismaClients. The engine is never reached: each client's log
 * events are raised on the emitter Prisma's own `$on` subscribes to, the one its engine raises
 * them on.
 */

type LogEmitter = { emit: (event: string, payload: unknown) => boolean };
const raise = (client: object, level: string, payload: unknown) =>
  (client as { _engineConfig: { logEmitter: LogEmitter } })._engineConfig.logEmitter.emit(
    level,
    payload
  );

const CLOSED = {
  timestamp: new Date(0),
  message: 'Error in PostgreSQL connection: Error { kind: Closed, cause: None }',
  target: 'quaint::connector::postgres',
};

const onLog = vi.fn();
const clients = createPrismaClients({
  databaseUrl: 'postgresql://unused@127.0.0.1:1/write',
  replicaUrl: 'postgresql://unused@127.0.0.1:1/read',
  logging: ['prisma:error', 'prisma:warn'],
  onLog,
});
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  onLog.mockReset();
});
afterEach(() => logSpy.mockRestore());
afterAll(async () => {
  await clients.dbWrite.$disconnect();
  await clients.dbRead.$disconnect();
});

describe('createPrismaClients log events', () => {
  it.each(['dbWrite', 'dbRead'] as const)('%s prints and forwards an error event', (name) => {
    expect(clients.dbRead).not.toBe(clients.dbWrite);

    raise(clients[name], 'error', CLOSED);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith('prisma:error', CLOSED.message);
    expect(onLog).toHaveBeenCalledTimes(1);
    expect(onLog).toHaveBeenCalledWith({ level: 'error', line: `prisma:error ${CLOSED.message}` });
  });

  it('does not print a level LOGGING does not enable', () => {
    raise(clients.dbWrite, 'info', { ...CLOSED, message: 'Starting a postgresql pool' });

    expect(logSpy).not.toHaveBeenCalled();
    expect(onLog).not.toHaveBeenCalled();
  });
});
