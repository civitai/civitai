import { styleText } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prismaLogConfig, prismaLogPrinter } from './client';

const CLOSED = 'Error in PostgreSQL connection: Error { kind: Closed, cause: None }';

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // A test worker's stdout is not a TTY, so without this nothing is coloured and an uncoloured
  // forward cannot be told apart from a coloured one.
  vi.stubEnv('FORCE_COLOR', '1');
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  logSpy.mockRestore();
  vi.unstubAllEnvs();
});

describe('prismaLogConfig', () => {
  it('subscribes to every configured level as an event and prints each of them', () => {
    expect(prismaLogConfig(['prisma:error', 'prisma:warn', 'redis'])).toEqual({
      log: [
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'warn' },
      ],
      printed: ['error', 'warn'],
    });
  });

  it('leaves query lines unprinted when slow-query logging takes the query event', () => {
    expect(prismaLogConfig(['prisma:query', 'prisma:error', 'prisma-slow-read'])).toEqual({
      log: [
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'query' },
      ],
      printed: ['error'],
    });
  });
});

describe('prismaLogPrinter', () => {
  it('prints the line Prisma prints and forwards it uncoloured', () => {
    const onLog = vi.fn();

    prismaLogPrinter('error', onLog)({ message: CLOSED });

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith('\x1b[31mprisma:error\x1b[39m', CLOSED);
    expect(onLog).toHaveBeenCalledTimes(1);
    expect(onLog).toHaveBeenCalledWith({ level: 'error', line: `prisma:error ${CLOSED}` });
  });

  it('prints a query event by its query text', () => {
    const onLog = vi.fn();

    prismaLogPrinter('query', onLog)({ query: 'SELECT 1' });

    expect(logSpy).toHaveBeenCalledWith(styleText('blue', 'prisma:query'), 'SELECT 1');
    expect(onLog).toHaveBeenCalledWith({ level: 'query', line: 'prisma:query SELECT 1' });
  });

  it('still prints, and does not throw, when the forwarder throws', () => {
    const print = prismaLogPrinter('warn', () => {
      throw new Error('sink down');
    });

    expect(() => print({ message: 'pool exhausted' })).not.toThrow();
    expect(logSpy).toHaveBeenCalledWith(styleText('yellow', 'prisma:warn'), 'pool exhausted');
  });
});
