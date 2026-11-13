import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { replaceTriggerOrigin } from '~/server/services/user-restriction.service';

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
});

describe('replaceTriggerOrigin', () => {
  const origin = { remix: { imageId: 5, verified: true, promptMatch: 'identical' } };

  it('emits a statement that swaps one element, in order, on the owner’s pending rows only', async () => {
    await expect(replaceTriggerOrigin({ userId: 9, entryId: 'entry-1', origin })).resolves.toBe(1);

    const [strings, ...values] = dbMock.dbWrite.$executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[]
    ];
    const sql = strings.join('?').replace(/\s+/g, ' ');

    expect(sql).toContain("CASE WHEN t.e ->> 'id' = ?");
    expect(sql).toContain("jsonb_set(t.e, '{origin}', ?::jsonb)");
    expect(sql).toContain('ORDER BY t.ord');
    expect(sql).toContain('WITH ORDINALITY');
    expect(sql).toContain('ur.triggers @> ?::jsonb');
    expect(sql).toContain('ur."userId" = ?');
    expect(sql).toContain("ur.status = 'Pending'");
    expect(sql).toContain('"updatedAt" = now()');

    expect(values).toEqual([
      'entry-1',
      JSON.stringify(origin),
      9,
      JSON.stringify([{ id: 'entry-1' }]),
    ]);
  });
});
