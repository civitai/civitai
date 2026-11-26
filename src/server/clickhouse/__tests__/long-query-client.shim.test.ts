import { describe, expect, it, vi } from 'vitest';
import { envMock } from '~/__tests__/mocks/env.mock';

const created = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('@civitai/clickhouse/client', () => ({
  createClickhouseClient: (options: Record<string, unknown>) => {
    created.push(options);
    return { options };
  },
}));
vi.mock('~/server/clickhouse/tracker', () => ({}));
vi.mock('~/utils/logging', () => ({ createLogger: () => () => undefined }));

envMock.set({ IS_BUILD: false, CLICKHOUSE_HOST: 'http://ch.invalid', CLICKHOUSE_USERNAME: 'u' });
const { clickhouse, clickhouseLongQueries, LONG_QUERY_REQUEST_TIMEOUT_MS } = await import(
  '~/server/clickhouse/client'
);
const { REFEREE_CLICKHOUSE_BUDGET_S, SETTLE_LOCK_S } = await import(
  '~/server/events/points/referee'
);

describe('the long-query ClickHouse client', () => {
  it('is its own client with the long idle timeout; the shared one keeps the default', () => {
    expect(clickhouseLongQueries).not.toBe(clickhouse);
    const long = created.find((o) => o.requestTimeoutMs != null);
    const shared = created.filter((o) => o.requestTimeoutMs == null);
    expect(long?.requestTimeoutMs).toBe(LONG_QUERY_REQUEST_TIMEOUT_MS);
    expect(shared).toHaveLength(1);
  });
});
