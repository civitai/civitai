import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prismaLogConfig, prismaLogPrinter } from './client';

const CLOSED = 'Error in PostgreSQL connection: Error { kind: Closed, cause: None }';

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => logSpy.mockRestore());

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
  it.each([
    ['error', CLOSED],
    ['warn', 'pool exhausted'],
  ] as const)('prints and forwards a %s line', (level, message) => {
    const onLog = vi.fn();

    prismaLogPrinter(level, onLog)({ message });

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(`prisma:${level}`, message);
    expect(onLog).toHaveBeenCalledTimes(1);
    expect(onLog).toHaveBeenCalledWith({ level, line: `prisma:${level} ${message}` });
  });

  it('prints info and query lines but never forwards them', () => {
    const onLog = vi.fn();

    prismaLogPrinter('info', onLog)({ message: 'Starting a postgresql pool' });
    prismaLogPrinter('query', onLog)({ query: 'SELECT 1' });

    expect(logSpy).toHaveBeenCalledWith('prisma:info', 'Starting a postgresql pool');
    expect(logSpy).toHaveBeenCalledWith('prisma:query', 'SELECT 1');
    expect(onLog).not.toHaveBeenCalled();
  });

  it('still prints, and does not throw, when the forwarder throws', () => {
    const print = prismaLogPrinter('warn', () => {
      throw new Error('sink down');
    });

    expect(() => print({ message: 'pool exhausted' })).not.toThrow();
    expect(logSpy).toHaveBeenCalledWith('prisma:warn', 'pool exhausted');
  });
});
