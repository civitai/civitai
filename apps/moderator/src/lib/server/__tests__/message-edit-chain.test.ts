import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The transcript collapsed a message's edit log to the FIRST edit's `oldValue` and the LAST edit's
 * `newValue` and timestamp. Two defects, and the quieter one is worse.
 *
 * Every intermediate version was dropped — 144 of the 1,025 edited messages on the site are edited
 * more than once, and one is edited 21 times, so that message showed 2 of its 22 versions. A moderator
 * reported it.
 *
 * Nobody reported the other one: the surviving text was the ORIGINAL while the timestamp beside it was
 * the NEWEST edit's, so the panel dated text to a moment it did not exist at. It is correct for a
 * single edit, which is 86% of them, so it reads as true everywhere anyone would check.
 *
 * A revert therefore has to be caught on the PAIRING, not just the count — hence the per-entry
 * assertions below rather than a length check alone.
 */

const rows = vi.hoisted(() => [] as Record<string, unknown>[]);
const recorded = vi.hoisted(() => [] as Record<string, unknown>[]);
const down = vi.hoisted(() => ({ clickhouse: false, recorded: false }));

vi.mock('../clickhouse', () => ({
  getClickhouse: () => ({
    $query: () => (down.clickhouse ? Promise.reject(new Error('down')) : Promise.resolve(rows)),
  }),
}));

const message = vi.hoisted(() => ({
  id: 7,
  createdAt: new Date('2026-09-01T00:00:00Z'),
  userId: 1,
  content: 'v4',
  editedAt: new Date('2026-09-04T00:00:00Z'),
  deletedAt: null,
  username: 'someone',
  bannedAt: null,
}));

vi.mock('../db', () => {
  let table = '';
  const chain = {
    selectFrom: (t: string) => ((table = t), chain),
    leftJoin: () => chain,
    innerJoin: () => chain,
    select: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    execute: () => {
      if (table !== 'ChatMessageEdit') return Promise.resolve([message]);
      // The relation-missing error a build deployed before its migration gets.
      return down.recorded ? Promise.reject(new Error('42P01')) : Promise.resolve(recorded);
    },
  };
  return { dbRead: chain };
});

vi.mock('../users.service', () => ({
  SYSTEM_USER_ID: -1,
  isInt4Id: () => true,
  usernameExists: () => Promise.resolve(true),
}));

const { getTranscript } = await import('../chat-audit.service');

const edit = (at: string, oldValue: string, newValue: string, actorRole = 'owner') => ({
  messageId: '7',
  createdAt: at,
  oldValue,
  newValue,
  truncated: 0,
  actorRole,
});

beforeEach(() => {
  rows.length = 0;
  recorded.length = 0;
  down.clickhouse = false;
  down.recorded = false;
});

describe('a message edited three times', () => {
  beforeEach(() => {
    rows.push(
      edit('2026-09-02 10:00:00', 'v1', 'v2'),
      edit('2026-09-03 10:00:00', 'v2', 'v3'),
      edit('2026-09-04 10:00:00', 'v3', 'v4', 'moderator')
    );
  });

  it('keeps every version rather than the first and last', async () => {
    const { edits } = await getTranscript(1);

    expect(edits?.[7]).toHaveLength(3);
    // v2 and v3 are the ones a collapse throws away, and no count-only assertion notices.
    expect(edits?.[7].map((e) => e.oldValue)).toEqual(['v1', 'v2', 'v3']);
  });

  it('pairs each version with the timestamp of the edit that replaced it', async () => {
    const { edits } = await getTranscript(1);

    // The defect this replaces put 'v1' next to the 09-04 timestamp. Asserting the pairing is the only
    // way to see that — the text alone was right, and the timestamp alone was right.
    expect(edits?.[7][0]).toMatchObject({ oldValue: 'v1', at: '2026-09-02T10:00:00Z' });
    expect(edits?.[7][2]).toMatchObject({ oldValue: 'v3', at: '2026-09-04T10:00:00Z' });
  });

  it('attributes each edit to its own actor', async () => {
    const { edits } = await getTranscript(1);

    // Collapsing kept whichever role came last, so a sender's edits were reported as a moderator's.
    expect(edits?.[7].map((e) => e.actorRole)).toEqual(['owner', 'owner', 'moderator']);
  });

  it('chains, so the panel can render a sequence', async () => {
    const { edits } = await getTranscript(1);
    const chain = edits?.[7] ?? [];

    for (let i = 1; i < chain.length; i += 1) expect(chain[i].oldValue).toBe(chain[i - 1].newValue);
    expect(chain.at(-1)?.newValue).toBe(message.content);
  });
});

describe('a message edited once', () => {
  beforeEach(() => {
    rows.push(edit('2026-09-02 10:00:00', 'only-original', 'v4'));
  });

  it('is a one-entry list, not a bare object', async () => {
    // The 86% case, and the one the old shape got right — so it has to keep working across the change.
    const { edits } = await getTranscript(1);

    expect(edits?.[7]).toHaveLength(1);
    expect(edits?.[7][0].oldValue).toBe('only-original');
  });
});

const recordedEdit = (at: string, previousContent: string, editorId = message.userId) => ({
  messageId: 7,
  editorId,
  previousContent,
  createdAt: new Date(at),
});

describe('edits recorded in Postgres', () => {
  it('chains each recorded edit to the next, ending at the current content', async () => {
    recorded.push(
      recordedEdit('2026-09-02T10:00:00Z', 'v1'),
      recordedEdit('2026-09-03T10:00:00Z', 'v2', 99)
    );
    const { edits, editsPartial } = await getTranscript(1);

    expect(edits[7]).toEqual([
      expect.objectContaining({ oldValue: 'v1', newValue: 'v2', actorRole: 'owner' }),
      expect.objectContaining({ oldValue: 'v2', newValue: 'v4', actorRole: 'moderator' }),
    ]);
    expect(editsPartial).toBe(false);
  });

  it('keeps edits only the log saw, and shows an edit both sources hold once', async () => {
    // v1 -> v2 predates the table. v2 -> v4 is in both: the log row lands a moment after.
    rows.push(edit('2026-09-02 10:00:00', 'v1', 'v2'), edit('2026-09-03 10:00:01', 'v2', 'v4'));
    recorded.push(recordedEdit('2026-09-03T10:00:00Z', 'v2'));
    const { edits } = await getTranscript(1);

    expect(edits[7].map((e) => [e.oldValue, e.newValue])).toEqual([
      ['v1', 'v2'],
      ['v2', 'v4'],
    ]);
  });

  it('matches a logged edit to the recorded edit it is, not one from the same text', async () => {
    // During a rolling deploy: v1 -> v2 on the old build (logged only), then v2 -> v1 -> v4 on the new
    // one, all inside the match window. The first logged edit shares its replaced text with the last
    // recorded one; matching on that alone dropped the original and showed v1 -> v4 twice.
    rows.push(
      edit('2026-09-03 10:00:00', 'v1', 'v2'),
      edit('2026-09-03 10:00:10', 'v2', 'v1'),
      edit('2026-09-03 10:00:20', 'v1', 'v4')
    );
    recorded.push(
      recordedEdit('2026-09-03T10:00:10Z', 'v2'),
      recordedEdit('2026-09-03T10:00:20Z', 'v1')
    );
    const { edits } = await getTranscript(1);

    expect(edits[7].map((e) => [e.oldValue, e.newValue])).toEqual([
      ['v1', 'v2'],
      ['v2', 'v1'],
      ['v1', 'v4'],
    ]);
  });

  it('pairs each logged edit with the closest recorded one when the text goes back and forth', async () => {
    // A -> B logged only (old build), then B -> A and A -> B in both. The first logged A -> B is 20s
    // from the recorded A -> B and must not take it from the logged A -> B that IS it.
    rows.push(
      edit('2026-09-03 10:00:00', 'A', 'B'),
      edit('2026-09-03 10:00:10', 'B', 'A'),
      edit('2026-09-03 10:00:20', 'A', 'B')
    );
    recorded.push(
      recordedEdit('2026-09-03T10:00:10Z', 'B'),
      recordedEdit('2026-09-03T10:00:20Z', 'A')
    );
    message.content = 'B';
    try {
      const { edits } = await getTranscript(1);
      expect(edits[7].map((e) => [e.oldValue, e.newValue, e.at])).toEqual([
        ['A', 'B', '2026-09-03T10:00:00Z'],
        ['B', 'A', '2026-09-03T10:00:10.000Z'],
        ['A', 'B', '2026-09-03T10:00:20.000Z'],
      ]);
    } finally {
      message.content = 'v4';
    }
  });

  it('keeps a logged edit that repeats a recorded one outside the window', async () => {
    // The same A -> B a day apart is two edits, not one seen twice.
    rows.push(edit('2026-09-02 10:00:00', 'v2', 'v4'));
    recorded.push(recordedEdit('2026-09-03T10:00:00Z', 'v2'));
    const { edits } = await getTranscript(1);

    expect(edits[7]).toHaveLength(2);
  });

  it('says the history is incomplete rather than show part of an unbounded one', async () => {
    // Edits are not rate-limited; the read is capped at 5,000 rows and the mock ignores the LIMIT.
    for (let i = 0; i < 5_001; i++) recorded.push(recordedEdit('2026-09-03T10:00:00Z', `x${i}`));
    const { edits, editsPartial } = await getTranscript(1);

    expect(editsPartial).toBe(true);
    expect(edits[7]).toBeUndefined();
  });

  it('still shows recorded edits when the log is down, and says history may be missing', async () => {
    down.clickhouse = true;
    recorded.push(recordedEdit('2026-09-03T10:00:00Z', 'v3'));
    const { edits, editsPartial } = await getTranscript(1);

    expect(edits[7].map((e) => e.oldValue)).toEqual(['v3']);
    expect(editsPartial).toBe(true);
  });

  it('still loads from the log before the table exists', async () => {
    down.recorded = true;
    rows.push(edit('2026-09-02 10:00:00', 'v1', 'v4'));
    const { edits, editsPartial } = await getTranscript(1);

    expect(edits[7].map((e) => e.oldValue)).toEqual(['v1']);
    expect(editsPartial).toBe(true);
  });
});
