import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * `inSongTagTransaction`, the transaction `setSongGenre` writes a genre and its tag rows in, on a
 * fake primary connection that records what it was asked to run.
 */

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  failOn: undefined as string | undefined,
  release: vi.fn(),
}));

vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: {},
  pgDbReadLong: {},
  pgDbWrite: {
    connect: vi.fn(async () => ({
      query: async (text: string) => {
        mocks.events.push(text);
        if (text === mocks.failOn) throw new Error(`${text} failed`);
        return { rows: [] };
      },
      release: mocks.release,
    })),
  },
}));

import { inSongTagTransaction } from '~/server/services/tagsOnSong.service';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.events = [];
  mocks.failOn = undefined;
});

/** A write that runs one statement and queues two follow-up steps, as the tag writers do. */
const writeWithSteps = (steps: (() => Promise<void>)[]) =>
  inSongTagTransaction(async (tx) => {
    await tx.client.query('UPDATE "Track"');
    tx.afterCommit.push(...steps);
    return 'written';
  });
const step =
  (name: string, fail = false) =>
  async () => {
    mocks.events.push(name);
    if (fail) throw new Error(`${name} failed`);
  };

describe('inSongTagTransaction', () => {
  it('commits before any follow-up step runs, then releases the connection', async () => {
    const result = await writeWithSteps([step('bust'), step('search')]);

    expect(result).toBe('written');
    expect(mocks.events).toEqual(['BEGIN', 'UPDATE "Track"', 'COMMIT', 'bust', 'search']);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('hands the write the tag rules read before the transaction began', async () => {
    const stored = [{ fromId: 1, toId: 2, fromTag: 'a', toTag: 'b', type: 'Replace' }];
    redisMock.redis.get.mockImplementation((async (key: string) => {
      if (key !== 'system:tag-rules') return null;
      mocks.events.push('rules');
      return JSON.stringify(stored);
    }) as never);
    // Fresh modules: the rules' in-process memo holds what an earlier test read.
    vi.resetModules();
    const fresh = await import('~/server/services/tagsOnSong.service');
    let rules: unknown;
    await fresh.inSongTagTransaction(async (tx) => {
      rules = tx.tagRules;
    });

    expect(rules).toEqual(stored);
    expect(mocks.events).toEqual(['rules', 'BEGIN', 'COMMIT']);
  });

  it('rolls back a failing write, runs none of its follow-ups and releases the connection', async () => {
    mocks.failOn = 'UPDATE "Track"';

    await expect(writeWithSteps([step('bust')])).rejects.toThrow('UPDATE "Track" failed');

    expect(mocks.events).toEqual(['BEGIN', 'UPDATE "Track"', 'ROLLBACK']);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it.each(['BEGIN', 'COMMIT'])(
    'releases the connection and runs no follow-up when %s fails',
    async (failing) => {
      mocks.failOn = failing;

      await expect(writeWithSteps([step('bust')])).rejects.toThrow(`${failing} failed`);

      expect(mocks.events).not.toContain('bust');
      expect(mocks.release).toHaveBeenCalledTimes(1);
    }
  );

  it('logs a failing follow-up and still runs the next, keeping the committed result', async () => {
    const result = await writeWithSteps([step('bust', true), step('search')]);

    expect(result).toBe('written');
    expect(mocks.events).toEqual(['BEGIN', 'UPDATE "Track"', 'COMMIT', 'bust', 'search']);
    expect(loggingMock.logToAxiom).toHaveBeenCalledTimes(1);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', name: 'song-tag-after-commit' })
    );
  });
});
