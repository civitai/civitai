import { beforeEach, describe, expect, it, vi } from 'vitest';

// The gate's only DB read counts the caller's versions still on Download; every chained builder call
// returns the same stub so the answer is whatever `downloadCount` says.
const state = vi.hoisted(() => ({ downloadCount: '1', writes: 0 }));

vi.mock('$lib/server/db', () => {
  const read: Record<string, unknown> = {};
  for (const m of ['selectFrom', 'innerJoin', 'where', 'select'])
    read[m] = () => read;
  read.executeTakeFirst = async () => ({ count: state.downloadCount });
  const write: Record<string, unknown> = {};
  for (const m of ['updateTable', 'set', 'where', 'from'])
    write[m] = () => write;
  write.executeTakeFirst = async () => {
    state.writes++;
    return { numUpdatedRows: 1n };
  };
  return { dbRead: read, dbWrite: write };
});
vi.mock('$lib/server/main-app', () => ({ callMainApp: vi.fn() }));
vi.mock('$env/dynamic/private', () => ({ env: {} }));

import { setUsageControl } from '../monetization/paid-access';
import { canSetGenerationOnly } from '../membership';

beforeEach(() => {
  state.downloadCount = '1';
  state.writes = 0;
});

describe('setUsageControl — moving a Download version to generation-only', () => {
  it('refuses a signed-out caller with a sign-in message, not a membership upsell', async () => {
    const result = await setUsageControl(1, 10, 'Generation', canSetGenerationOnly(undefined));
    expect(result).toEqual({
      ok: false,
      status: 403,
      error: 'Sign in to make a resource generation-only.',
    });
    expect(state.writes).toBe(0);
  });

  it('lets a signed-in free-tier creator through', async () => {
    const result = await setUsageControl(
      1,
      10,
      'Generation',
      canSetGenerationOnly({ id: 1, tier: 'free' } as never)
    );
    expect(result.ok).toBe(true);
    expect(state.writes).toBe(1);
  });
});
