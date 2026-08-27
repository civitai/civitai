import { describe, expect, it, vi, beforeEach } from 'vitest';

// A real workflow id: the `-<YYYYMMDDHHMMSS>` half is what bounds the ClickHouse window, so the tests
// that assert the window depend on this shape rather than on an arbitrary string.
const WORKFLOW = 'wf-20260825161500-abc';

const chQuery = vi.fn();
vi.mock('$lib/server/clickhouse', () => ({ getClickhouse: () => ({ $query: chQuery }) }));

let versionRow: Record<string, unknown> | undefined;
let fileRows: { metadata: unknown }[];
let payerRow: Record<string, unknown> | undefined;

// One fake per query shape rather than a shared builder: `getTrainingProvenance` makes three distinct
// reads and a builder that answered them all identically could not tell a swapped one from a correct one.
vi.mock('$lib/server/db', () => {
  const chain = (result: unknown, terminal: 'first' | 'many') => {
    const self: Record<string, unknown> = {};
    for (const method of ['innerJoin', 'leftJoin', 'select', 'where'])
      self[method] = () => self as never;
    self.executeTakeFirst = async () => (terminal === 'first' ? result : undefined);
    self.execute = async () => (terminal === 'many' ? result : []);
    return self;
  };
  return {
    dbRead: {
      selectFrom: (table: string) => {
        if (table === 'ModelVersion as mv') return chain(versionRow, 'first');
        if (table === 'ModelFile') return chain(fileRows, 'many');
        if (table === 'User') return chain(payerRow, 'first');
        throw new Error(`unexpected table ${table}`);
      },
    },
    dbWrite: {},
  };
});

vi.mock('$lib/server/training-moderation.service', () => ({
  TRAINING_DATA_FILE_TYPE: 'Training Data',
}));

const { getTrainingProvenance } = await import('../training-provenance.service');

const trainingFile = (workflowId: string | null) => [
  { metadata: { trainingResults: workflowId ? { workflowId } : {} } },
];

beforeEach(() => {
  chQuery.mockReset();
  versionRow = { uploaderUserId: 10, uploaderUsername: 'uploader' };
  fileRows = trainingFile(WORKFLOW);
  payerRow = { username: 'trainer' };
});

describe('getTrainingProvenance', () => {
  it('flags a run paid for by an account that does not own the model', async () => {
    chQuery.mockResolvedValue([{ payer: 99, date: '2026-08-25 16:15:00' }]);

    const result = await getTrainingProvenance(1);

    expect(result).toMatchObject({
      payerUserId: 99,
      payerUsername: 'trainer',
      uploaderUserId: 10,
      mismatch: true,
      reachable: true,
    });
  });

  it('does NOT flag the ordinary case where trainer and uploader are one account', async () => {
    chQuery.mockResolvedValue([{ payer: 10, date: '2026-08-25 16:15:00' }]);

    // The whole value of the badge is that it means something when it appears — a version that flags
    // every model is one a moderator learns to ignore.
    expect(await getTrainingProvenance(1)).toMatchObject({ mismatch: false, reachable: true });
  });

  it('reports a ClickHouse failure as unreachable, never as "no mismatch"', async () => {
    chQuery.mockRejectedValue(new Error('clickhouse down'));

    // Reading an outage as a clean bill is the one wrong answer that is invisible: the panel would
    // say trainer and uploader agree about a run it never looked up.
    expect(await getTrainingProvenance(1)).toMatchObject({
      reachable: false,
      mismatch: false,
      payerUserId: null,
    });
  });

  it('separates "no charge found" from "could not look"', async () => {
    chQuery.mockResolvedValue([]);
    expect(await getTrainingProvenance(1)).toMatchObject({ reachable: true, payerUserId: null });
  });

  it('returns null when the version records no training run', async () => {
    fileRows = trainingFile(null);
    const result = await getTrainingProvenance(1);
    expect(result).toBeNull();
    expect(chQuery).not.toHaveBeenCalled();
  });

  it('bounds the ClickHouse window to the submit second the workflow id carries', async () => {
    chQuery.mockResolvedValue([]);
    await getTrainingProvenance(1);

    // Unbounded, this query scans the full buzzTransactions history — the service it inverts measures
    // 19.1s over 912 days against 0.7s over 7. A revert that drops the bound leaves these absent.
    const query = chQuery.mock.calls[0][0] as string;
    expect(query).toContain("date >= '2026-08-25 16:13:00'");
    expect(query).toContain("date <= '2026-08-25 16:17:00'");
  });

  it('refuses a workflow id that could not have come from the orchestrator', async () => {
    // The id is interpolated into SQL, so the shape check is the only thing between a metadata blob
    // and the query. A rejected id must read as "nothing to link", not run.
    fileRows = trainingFile("wf'; DROP TABLE buzzTransactions--");

    expect(await getTrainingProvenance(1)).toBeNull();
    expect(chQuery).not.toHaveBeenCalled();
  });
});
