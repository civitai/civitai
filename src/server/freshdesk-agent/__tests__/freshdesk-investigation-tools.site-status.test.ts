import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));

const { checkSiteStatus } = await import('~/server/freshdesk-agent/freshdesk-investigation-tools');

const fetchMock = vi.fn<
  (url: string, init?: { headers?: Record<string, string> }) => Promise<unknown>
>(async () => ({ ok: true, status: 200, json: async () => ({ healthy: true }) }));

beforeEach(() => {
  resetEnv();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  dbMock.dbRead.$queryRaw.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllGlobals());

async function healthCall() {
  const status = await checkSiteStatus();
  expect(status).toContain('Overall: HEALTHY');
  const [url, init] = fetchMock.mock.calls[0];
  return { url, authorization: init?.headers?.authorization };
}

describe('checkSiteStatus', () => {
  it('calls /api/health with PROBE_TOKEN as Bearer, not in the query string', async () => {
    setEnv({ WEBHOOK_TOKEN: 'webhook-value', PROBE_TOKEN: 'probe-value' });
    const { url, authorization } = await healthCall();
    expect(url).toMatch(/\/api\/health$/);
    expect(authorization).toBe('Bearer probe-value');
  });

  it('falls back to the webhook token while PROBE_TOKEN is unset or blank', async () => {
    for (const probe of [undefined, '', '   ']) {
      setEnv({ WEBHOOK_TOKEN: 'webhook-value', PROBE_TOKEN: probe });
      fetchMock.mockClear();
      const { url, authorization } = await healthCall();
      expect(url).not.toContain('token=');
      expect(authorization).toBe('Bearer webhook-value');
    }
  });
});
