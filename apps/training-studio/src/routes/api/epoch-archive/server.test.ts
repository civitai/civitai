import { describe, expect, it, vi } from 'vitest';
import { RunWithheldError } from '$lib/server/withheld';

const createEpochArchive = vi.fn();
const assertNotWithheld = vi.fn(async (_cookie: string, _id: string) => undefined);
vi.mock('@civitai/orchestration-client', () => ({}));
vi.mock('$lib/server/token', () => ({ requireToken: async () => 'token' }));
vi.mock('$lib/server/orchestrator', () => ({
  createEpochArchive: (...args: unknown[]) => createEpochArchive(...args),
}));
vi.mock('$lib/server/withheld', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/withheld')>()),
  assertNotWithheld: (cookie: string, id: string) => assertNotWithheld(cookie, id),
}));

const { POST } = await import('./+server');

const archive = (kind: string) =>
  POST({
    locals: { user: { id: 1 } },
    request: new Request('http://x', { method: 'POST', headers: { cookie: 'civ-token=x' } }),
    url: new URL(`http://x/api/epoch-archive?id=wf-1&kind=${kind}`),
  } as unknown as Parameters<typeof POST>[0]);

describe('POST /api/epoch-archive', () => {
  it.each(['weights', 'samples'])('refuses a withheld run its %s', async (kind) => {
    createEpochArchive.mockClear();
    assertNotWithheld.mockRejectedValueOnce(new RunWithheldError());
    await expect(archive(kind)).rejects.toMatchObject({ status: 403 });
    expect(assertNotWithheld).toHaveBeenLastCalledWith('civ-token=x', 'wf-1');
    expect(createEpochArchive).not.toHaveBeenCalled();
  });

  it('archives a run that is not withheld', async () => {
    createEpochArchive.mockResolvedValueOnce([{ url: 'https://x/zip', archiveName: 'a.zip' }]);
    const res = await archive('weights');
    expect(await res.json()).toEqual([{ url: 'https://x/zip', archiveName: 'a.zip' }]);
  });
});
