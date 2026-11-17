import { afterEach, describe, expect, it, vi } from 'vitest';
import { MatureAckRequiredError } from './mature-charge';
import { shellBackend } from './shell-backend';
import { AutoLabelRefusedError } from './autolabel-errors';
import {
  FILES_PROCESSING_CODE,
  FILES_PROCESSING_MESSAGE,
  FilesProcessingError,
} from './files-processing';

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

describe('auto-label submit failures decide whether the image keeps its cap slot', () => {
  const submit = () =>
    shellBackend.autoLabelSubmit([{ key: 'k', mediaUrl: 'https://x/a.png' }], 'tag', 'image');
  const body = (b: object, status: number) => Response.json(b, { status });

  it('our own marked 503 is a refusal that keeps the user-facing message', async () => {
    fetchMock.mockResolvedValueOnce(
      body(
        { message: 'Auto-labeling is unavailable right now.', code: 'auto_label_unavailable' },
        503
      )
    );
    const err = await submit().catch((e) => e);
    expect(err).toBeInstanceOf(AutoLabelRefusedError);
    expect(err.message).toBe('Auto-labeling is unavailable right now.');
  });

  it.each([400, 401, 403, 413, 429])('a %i from our route is a refusal', async (status) => {
    fetchMock.mockResolvedValueOnce(body({ message: 'no' }, status));
    expect(await submit().catch((e) => e)).toBeInstanceOf(AutoLabelRefusedError);
  });

  it.each([500, 502, 503, 504])('an unmarked %i may have been charged', async (status) => {
    fetchMock.mockResolvedValueOnce(body({ message: 'upstream' }, status));
    const err = await submit().catch((e) => e);
    expect(err).not.toBeInstanceOf(AutoLabelRefusedError);
    expect(err.message).toBe(`auto-label submit failed (${status})`);
  });

  it('a network failure after send may have been charged', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await submit().catch((e) => e)).not.toBeInstanceOf(AutoLabelRefusedError);
  });
});

describe('a training submit refused while files are still processing', () => {
  it('comes back as FilesProcessingError so the retry can show', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { message: FILES_PROCESSING_MESSAGE, code: FILES_PROCESSING_CODE },
        { status: 400 }
      )
    );
    const err = await shellBackend.submitTraining([]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FilesProcessingError);
  });

  it('keeps any other 400 a plain error with the server message', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ message: 'Training could not start: bad steps' }, { status: 400 })
    );
    const err = await shellBackend.submitTraining([]).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(FilesProcessingError);
    expect((err as Error).message).toBe('Training could not start: bad steps');
  });
});
