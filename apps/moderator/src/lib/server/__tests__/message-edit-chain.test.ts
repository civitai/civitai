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

vi.mock('../clickhouse', () => ({
  getClickhouse: () => ({ $query: () => Promise.resolve(rows) }),
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
  const chain = {
    selectFrom: () => chain,
    leftJoin: () => chain,
    innerJoin: () => chain,
    select: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    execute: () => Promise.resolve([message]),
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

describe('a message edited three times', () => {
  beforeEach(() => {
    rows.length = 0;
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
    rows.length = 0;
    rows.push(edit('2026-09-02 10:00:00', 'only-original', 'v4'));
  });

  it('is a one-entry list, not a bare object', async () => {
    // The 86% case, and the one the old shape got right — so it has to keep working across the change.
    const { edits } = await getTranscript(1);

    expect(edits?.[7]).toHaveLength(1);
    expect(edits?.[7][0].oldValue).toBe('only-original');
  });
});
