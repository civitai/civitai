import { beforeEach, describe, expect, it, vi } from 'vitest';
import { banDisabledMarkKey } from '@civitai/auth/ban-disabled-mark';

// The DB write and the cache Redis are the boundaries; `order` records which ran first.
const h = vi.hoisted(() => ({
  order: [] as string[],
  updated: [] as Record<string, unknown>[],
  del: vi.fn(),
}));

vi.mock('$lib/server/db/db', () => ({
  db: {
    updateTable() {
      const qb: Record<string, unknown> = {};
      qb.set = (values: Record<string, unknown>) => {
        h.updated.push(values);
        return qb;
      };
      qb.where = () => qb;
      qb.returning = () => qb;
      qb.executeTakeFirst = async () => {
        h.order.push('update');
        return { id: 'x' };
      };
      return qb;
    },
  },
}));
vi.mock('$lib/server/redis', () => ({ getRedis: () => ({ del: h.del }) }));

const { actions } = await import('../+page.server');

const setMode = (id: string, accessMode: string) => {
  const form = new FormData();
  form.set('id', id);
  form.set('accessMode', accessMode);
  return (actions.setMode as (e: unknown) => Promise<unknown>)({
    request: new Request('https://auth.example/admin/access?/setMode', {
      method: 'POST',
      body: form,
    }),
  });
};

beforeEach(() => {
  h.order.length = 0;
  h.updated.length = 0;
  h.del.mockReset();
  h.del.mockImplementation(async () => {
    h.order.push('clear-mark');
    return 1;
  });
});

describe('admin access: setMode', () => {
  it.each(['open', 'disabled', 'testers'])(
    '🔴 setting %s clears the ban-disabled mark first, so the owner cannot undo a staff decision',
    async (mode) => {
      const result = await setMode('appassist-7', mode);
      expect(result).toMatchObject({ success: true, accessMode: mode });
      expect(h.del).toHaveBeenCalledWith(banDisabledMarkKey('appassist-7'));
      expect(h.order).toEqual(['clear-mark', 'update']);
      expect(h.updated).toEqual([{ accessMode: mode }]);
    }
  );

  it('🔴 a mark that cannot be cleared saves nothing (503)', async () => {
    h.del.mockRejectedValue(new Error('cache down'));
    const result = await setMode('appassist-7', 'disabled');
    expect(result).toMatchObject({ status: 503 });
    expect(h.updated).toEqual([]);
  });
});
