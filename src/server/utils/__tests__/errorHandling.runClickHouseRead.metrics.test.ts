import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clickhouseFailSoftCounter } from '~/server/prom/client';
import { runClickHouseRead } from '~/server/utils/errorHandling';

const inc = vi.mocked(clickhouseFailSoftCounter.inc);

describe('runClickHouseRead — clickhouseFailSoftCounter', () => {
  beforeEach(() => {
    inc.mockClear();
  });

  it('counts a `socket hang up` under the caller-supplied path', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('ClickHouse query failed: socket hang up'));
    await expect(runClickHouseRead(fn, { path: 'buzz-compensation' })).rejects.toThrow();
    expect(inc).toHaveBeenCalledTimes(1);
    expect(inc).toHaveBeenCalledWith({ path: 'buzz-compensation' });
  });

  it('counts a raw syscall reset under the caller-supplied path', async () => {
    const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    await expect(
      runClickHouseRead(() => Promise.reject(err), { path: 'new-order-ratings' })
    ).rejects.toThrow();
    expect(inc).toHaveBeenCalledTimes(1);
    expect(inc).toHaveBeenCalledWith({ path: 'new-order-ratings' });
  });

  it('does NOT count a syntax fault (Code: 62)', async () => {
    const original = new Error('ClickHouse query failed: Code: 62. DB::Exception: Syntax error');
    const err = await runClickHouseRead(() => Promise.reject(original), {
      path: 'buzz-compensation',
    }).catch((e) => e);
    expect(err).toBe(original);
    expect(inc).not.toHaveBeenCalled();
  });

  it('does NOT count an UNKNOWN_TABLE fault (Code: 60)', async () => {
    const original = new Error(
      'ClickHouse query failed: Code: 60. DB::Exception: Table orchestration.resourceCompensations does not exist'
    );
    const err = await runClickHouseRead(() => Promise.reject(original), {
      path: 'model-version-generations',
    }).catch((e) => e);
    expect(err).toBe(original);
    expect(inc).not.toHaveBeenCalled();
  });

  it('does NOT count a successful read', async () => {
    const rows = [{ id: 1 }];
    await expect(runClickHouseRead(async () => rows, { path: 'buzz-compensation' })).resolves.toBe(
      rows
    );
    expect(inc).not.toHaveBeenCalled();
  });
});
