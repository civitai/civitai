import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// One pooled backend shared by every client, as behind a transaction pooler: a session SET stays
// on it after the client that ran it disconnects.
const backend = vi.hoisted(() => ({
  session: {} as Record<string, string>,
  inTxn: false,
  failStickers: false,
  clients: [] as { ended: boolean }[],
}));

vi.mock('pg', () => ({
  Client: class {
    ended = false;
    constructor() {
      backend.clients.push(this);
    }
    async connect() {
      return undefined;
    }
    async query(sql: string) {
      if (sql === 'SET default_transaction_read_only = on') {
        backend.session.default_transaction_read_only = 'on';
      } else if (sql === 'BEGIN READ ONLY') {
        backend.inTxn = true;
      } else if (sql === 'COMMIT' || sql === 'ROLLBACK') {
        backend.inTxn = false;
      } else if (sql.includes('"EventTurfSticker"')) {
        if (backend.failStickers) throw new Error('relation "EventTurfSticker" does not exist');
      } else {
        throw new Error(`fake pg: unexpected query ${sql}`);
      }
      return { rows: [] };
    }
    async end() {
      this.ended = true;
      backend.inTxn = false;
    }
  },
}));

vi.mock('@clickhouse/client', () => ({
  createClient: () => ({
    query: async ({ query }: { query: string }) => ({
      json: async () => {
        if (query.includes("getSetting('readonly')")) return [{ r: 1 }];
        if (query.includes('WITH e AS'))
          return [
            {
              userId: 7,
              variant: 'control',
              firstSeen: 1_793_000_000,
              nVariants: 1,
              joined: 0,
              inviteDismissed: 0,
              feedSaved: 0,
              hatCountOpened: 0,
              hidAllHats: 0,
            },
          ];
        if (query.includes('count() AS n')) return [{ n: 1 }];
        return [];
      },
    }),
    close: async () => undefined,
  }),
}));

import { main } from '../readout';

describe('readout Postgres session', () => {
  const argv = process.argv;
  beforeEach(() => {
    backend.session = {};
    backend.inTxn = false;
    backend.failStickers = false;
    backend.clients = [];
    process.argv = ['node', 'readout', '--exp', 'hatTurfFeedCard', '--json'];
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.argv = argv;
    vi.restoreAllMocks();
  });

  it('leaves the pooled backend writable for the next client', async () => {
    await main();
    expect(backend.clients).toHaveLength(1);
    expect(backend.session.default_transaction_read_only).toBeUndefined();
    expect(backend.inTxn).toBe(false);
  });

  it('closes the connection when a query fails, so the process can exit', async () => {
    backend.failStickers = true;
    await expect(main()).rejects.toThrow('EventTurfSticker');
    expect(backend.clients[0]?.ended).toBe(true);
  });
});
