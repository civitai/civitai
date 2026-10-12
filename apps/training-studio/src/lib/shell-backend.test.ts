import { afterEach, describe, expect, it, vi } from 'vitest';
import { shellBackend } from './shell-backend';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
afterEach(() => fetchMock.mockReset());

describe('keep-training requests carry the picked currencies', () => {
  it('quote sends them as repeated query params', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ cost: 1400 }));
    await shellBackend.continueQuote('wf-1', 10, 5, ['blue', 'green']);
    const url = new URL(fetchMock.mock.calls[0]![0] as string, 'http://x');
    expect(url.pathname).toBe('/api/continue-training');
    expect(url.searchParams.getAll('currencies')).toEqual(['blue', 'green']);
  });

  it('submit sends them in the body', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ workflowId: 'wf-2' }));
    await shellBackend.continueRun('wf-1', 10, 5, ['blue', 'green']);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string).currencies).toEqual(['blue', 'green']);
  });
});
