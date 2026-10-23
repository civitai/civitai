import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Axiom from '../axiom';
import type { Reader } from '../chat-read-audit';

const { insert, logAxiomError } = vi.hoisted(() => ({
  insert: vi.fn(),
  logAxiomError: vi.fn(async () => undefined),
}));

vi.mock('../clickhouse', () => ({ getClickhouse: () => ({ insert }) }));
vi.mock('../db', () => ({ dbRead: {} }));
vi.mock('../axiom', async (importOriginal) => ({
  ...(await importOriginal<typeof Axiom>()),
  logAxiomError,
}));

const { recordChatReads } = await import('../chat-read-audit');
const MOD = 9 as Reader;

beforeEach(() => {
  insert.mockReset();
  logAxiomError.mockClear();
});

describe('recordChatReads', () => {
  it('writes one read row per chat, attributed to the moderator, with no message text', async () => {
    insert.mockResolvedValue(undefined);
    await recordChatReads(MOD, [{ chatId: 4 }, { chatId: 5, subjectId: 3 }]);

    expect(insert).toHaveBeenCalledTimes(1);
    const { table, values } = insert.mock.calls[0][0];
    expect(table).toBe('chatAuditEvents');
    expect(values).toEqual([
      expect.objectContaining({ type: 'read', chatId: 4, actorId: 9, subjectId: 0 }),
      expect.objectContaining({ type: 'read', chatId: 5, actorId: 9, subjectId: 3 }),
    ]);
    for (const v of values) expect(v).toMatchObject({ oldValue: '', newValue: '' });
  });

  // Decided: the read trail fails OPEN. A ClickHouse outage must not stop moderators reading reports,
  // so the read goes ahead and the failure is logged. Do not turn this into a throw.
  it('lets the read go ahead when the log is down, and says so once', async () => {
    insert.mockRejectedValue(new Error('clickhouse down'));

    await expect(recordChatReads(MOD, [{ chatId: 4 }])).resolves.toBeUndefined();
    expect(logAxiomError).toHaveBeenCalledTimes(1);
    expect(logAxiomError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ event: 'chat-read-audit-failed', chatIds: [4], actorId: 9 })
    );
  });

  it('gives up on a stalled log rather than hold the read', async () => {
    // Settles only when aborted. Sent without a signal it fails at once, and the logged error says so.
    insert.mockImplementation(({ abort_signal }: { abort_signal?: AbortSignal }) =>
      abort_signal
        ? new Promise((_, reject) =>
            abort_signal.addEventListener('abort', () => reject(new Error('aborted')))
          )
        : Promise.reject(new Error('sent without an abort signal'))
    );
    const started = Date.now();
    await recordChatReads(MOD, [{ chatId: 4 }]);

    expect(Date.now() - started).toBeLessThan(4_000);
    expect(logAxiomError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'aborted' }),
      expect.anything()
    );
  });

  it('writes nothing for a read that showed nothing', async () => {
    await recordChatReads(MOD, []);
    expect(insert).not.toHaveBeenCalled();
  });
});
