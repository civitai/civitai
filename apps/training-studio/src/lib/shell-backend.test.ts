import { afterEach, describe, expect, it, vi } from 'vitest';
import { MatureAckRequiredError } from './mature-charge';
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
    await shellBackend.continueRun('wf-1', 10, 5, ['blue', 'green'], true);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string).currencies).toEqual(['blue', 'green']);
    expect(JSON.parse(init.body as string).matureAck).toBe(true);
    fetchMock.mockResolvedValueOnce(Response.json({ workflowId: 'wf-3' }));
    await shellBackend.continueRun('wf-1', 10, 5, ['blue'], false);
    const unacked = fetchMock.mock.calls[1]![1] as RequestInit;
    expect(JSON.parse(unacked.body as string).matureAck).toBe(false);
  });
});

describe('keep-training errors', () => {
  it('surfaces the server message, not the raw JSON body', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ message: 'pricing is down' }, { status: 502 }));
    await expect(shellBackend.continueQuote('wf-1', 10, 5, [])).rejects.toThrow(
      /^pricing is down$/
    );
  });
});

describe('a submit refused for a missing mature confirm', () => {
  const refusal = () =>
    Response.json({ message: 'Confirm the charge', matureCount: 3 }, { status: 409 });

  it.each([
    ['train', () => shellBackend.submitTraining([])],
    ['train further', () => shellBackend.continueRun('wf-1', 10, 5, ['blue'], false)],
  ])('%s hands back the mature count so the confirm can show', async (_, run) => {
    fetchMock.mockResolvedValueOnce(refusal());
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MatureAckRequiredError);
    expect((err as MatureAckRequiredError).matureCount).toBe(3);
  });

  it('keeps any other failure a plain error with the server message', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ message: 'busy' }, { status: 502 }));
    const err = await shellBackend.continueRun('wf-1', 10, 5, ['blue'], false).catch((e) => e);
    expect(err).not.toBeInstanceOf(MatureAckRequiredError);
    expect((err as Error).message).toBe('busy');
  });
});
