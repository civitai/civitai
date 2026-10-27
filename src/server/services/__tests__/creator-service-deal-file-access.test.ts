import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClickhouseClient from '~/server/clickhouse/client';

const holder = vi.hoisted(() => ({
  client: undefined as undefined | { query: ReturnType<typeof vi.fn> },
}));
vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  get clickhouse() {
    return holder.client;
  },
}));

const { listServiceDealFileAccess, getServiceDealFileAccessRecordedSince } = await import(
  '../creator-service-deal-file-access'
);

const answer = (rows: object[]) => {
  holder.client = { query: vi.fn(async () => ({ json: async () => rows })) };
  return holder.client.query;
};

beforeEach(() => {
  holder.client = undefined;
});

describe('reading the deal file access log', () => {
  it('fails rather than answering "nobody" when ClickHouse is not configured', async () => {
    await expect(listServiceDealFileAccess([1])).rejects.toThrow('ClickHouse is not configured');
    await expect(getServiceDealFileAccessRecordedSince()).rejects.toThrow(
      'ClickHouse is not configured'
    );
  });

  it('passes the deal ids as a parameter and turns the times into dates', async () => {
    // 64-bit values may come back as strings.
    const query = answer([
      {
        dealId: 4,
        fileId: 40,
        role: 'Buyer',
        kind: 'Download',
        count: 2,
        firstAt: '1730000000000',
        lastAt: 1730000005000,
      },
    ]);
    const [row] = await listServiceDealFileAccess([4, 5]);
    expect(row).toEqual({
      dealId: 4,
      fileId: 40,
      role: 'Buyer',
      kind: 'Download',
      count: 2,
      firstAt: new Date(1730000000000),
      lastAt: new Date(1730000005000),
    });
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ query_params: { dealIds: [4, 5] } })
    );
  });

  it('asks nothing for no deals', async () => {
    const query = answer([]);
    expect(await listServiceDealFileAccess([])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('says when recording began, or null before the first access', async () => {
    answer([{ since: null }]);
    expect(await getServiceDealFileAccessRecordedSince()).toBeNull();
    answer([{ since: '1730000000000' }]);
    expect(await getServiceDealFileAccessRecordedSince()).toEqual(new Date(1730000000000));
  });
});
