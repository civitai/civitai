import { beforeEach, describe, expect, it, vi } from 'vitest';

const { callModEndpoint } = vi.hoisted(() => ({ callModEndpoint: vi.fn() }));
vi.mock('../../../lib/server/user-actions.service', () => ({ callModEndpoint }));
vi.mock('../../../lib/server/blocklist.service', () => ({
  BlocklistRowMismatchError: class extends Error {},
  getBlocklistDTO: vi.fn(),
  upsertBlocklist: vi.fn(),
  removeBlocklistItems: vi.fn(),
}));
// The load's query parser reaches the database client, which throws at import without an env.
vi.mock('../../../lib/server/query', () => ({ parseQuery: vi.fn() }));

const { actions } = await import('../+page.server');

const dryRun = (query: string) => {
  const body = new FormData();
  body.set('query', query);
  const request = new Request('http://localhost/blocklists?/dryRun', { method: 'POST', body });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return actions.dryRun({ request, locals: { user: { id: 1 } } } as any);
};

const VERDICTS = {
  nonModerator: { verdict: 'poi', result: 'refuse' },
  moderator: { verdict: false, result: 'allow' },
};

describe('blocklists dry-run action', () => {
  beforeEach(() => {
    callModEndpoint.mockReset();
    callModEndpoint.mockResolvedValue({ ok: true, body: VERDICTS });
  });

  it('sends the trimmed query to the dry-run endpoint and returns its verdicts', async () => {
    const result = await dryRun('  a test query  ');
    expect(callModEndpoint).toHaveBeenCalledWith(
      'search-query-rule-dry-run',
      { query: 'a test query' },
      'Dry run'
    );
    expect(result).toEqual({ dryRun: { query: 'a test query', ...VERDICTS } });
  });

  it('passes on nothing the main app adds beyond the verdicts', async () => {
    callModEndpoint.mockResolvedValue({ ok: true, body: { ...VERDICTS, matched: 'zqvoxtoken' } });
    expect(JSON.stringify(await dryRun('q'))).not.toContain('zqvoxtoken');
  });

  it('refuses a query over 500 characters without calling the main app', async () => {
    expect(await dryRun('q'.repeat(501))).toMatchObject({ status: 400 });
    expect(callModEndpoint).not.toHaveBeenCalled();
  });

  it('refuses an empty query without calling the main app', async () => {
    expect(await dryRun('   ')).toMatchObject({ status: 400 });
    expect(callModEndpoint).not.toHaveBeenCalled();
  });

  it('shows the main app refusal, keeping its status', async () => {
    callModEndpoint.mockResolvedValue({ ok: false, error: 'Dry run: slow down', status: 429 });
    expect(await dryRun('q')).toMatchObject({
      status: 429,
      data: { dryRunError: 'Dry run: slow down' },
    });
  });

  it('reports a 502 when the main app answers in an unexpected shape', async () => {
    callModEndpoint.mockResolvedValue({ ok: true, body: { nonModerator: 'refuse' } });
    expect(await dryRun('q')).toMatchObject({ status: 502 });
  });

  it('reports a 502 when the main app could not be reached', async () => {
    callModEndpoint.mockResolvedValue({ ok: false, error: 'Dry run: fetch failed' });
    expect(await dryRun('q')).toMatchObject({
      status: 502,
      data: { dryRunError: 'Dry run: fetch failed' },
    });
  });
});
