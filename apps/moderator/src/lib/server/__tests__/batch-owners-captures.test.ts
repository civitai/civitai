import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FEEDBACK_CAPTURE_OWNER_ID } from '@civitai/shared/feedback-capture';

/** Striking or notifying a batch's owners skips feedback page captures and counts them. */

const captured = vi.hoisted(() => [] as string[]);
const rows = vi.hoisted(() => ({ current: [] as Record<string, unknown>[] }));
const issueStrike = vi.hoisted(() => vi.fn(async (_input: { userId: number }) => ({ ok: true })));

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  const db = capturingDb(captured, () => rows.current);
  return { dbRead: db, dbWrite: db };
});
vi.mock('$lib/server/user-actions.service', () => ({
  issueStrike,
  removeImages: vi.fn(),
  setImageFlag: vi.fn(),
}));

const { getBatchOwners, strikeBatchOwners } = await import('../bulk-image.service');

const CAPTURE = FEEDBACK_CAPTURE_OWNER_ID;

beforeEach(() => {
  vi.clearAllMocks();
  captured.length = 0;
});

describe('a batch with feedback page captures in it', () => {
  it('names every other owner once and counts the captures', async () => {
    rows.current = [
      { userId: 5, images: '2' },
      { userId: CAPTURE, images: '3' },
    ];
    expect(await getBatchOwners([1, 2, 3, 4, 5])).toEqual({ owners: [5], capturesSkipped: 3 });
  });

  it('strikes the other owners and never the capture account', async () => {
    rows.current = [
      { userId: 5, images: '1' },
      { userId: CAPTURE, images: '1' },
    ];
    const result = await strikeBatchOwners({ imageIds: [1, 2], description: 'd', moderatorId: 9 });
    expect(issueStrike.mock.calls.map(([input]) => input.userId)).toEqual([5]);
    expect(result).toEqual({ struck: 1, owners: 1, capturesSkipped: 1, error: undefined });
  });

  it('strikes nobody, and reports no failure, when the batch is all captures', async () => {
    rows.current = [{ userId: CAPTURE, images: '2' }];
    expect(await strikeBatchOwners({ imageIds: [1, 2], description: 'd', moderatorId: 9 })).toEqual(
      { struck: 0, owners: 0, capturesSkipped: 2 }
    );
    expect(issueStrike).not.toHaveBeenCalled();
  });
});
