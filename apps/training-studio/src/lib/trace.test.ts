import { afterEach, describe, expect, it, vi } from 'vitest';
import { followTrace, interpretTraceLine, traceLossPoints, tracePath } from './trace';

describe('traceLossPoints', () => {
  it('reads every tqdm redraw on a concatenated log line, skipping ones without a loss', () => {
    // The exact shape the worker's log capture produces: redraws joined once `\r` is stripped.
    const line =
      ' 10%|#         | 20/200 [00:08<01:12,  2.48it/s, lr: 1.0e-04 loss: 3.213e-01] 11%|#1        | 21/200 [00:09<01:11,  2.50it/s] 11%|#1        | 22/200 [00:09<01:11,  2.49it/s, lr: 1.0e-04 loss: 2.980e-01]';
    expect(traceLossPoints(line)).toEqual([
      { step: 20, losses: { loss: 0.3213 }, lr: 1e-4 },
      { step: 22, losses: { loss: 0.298 }, lr: 1e-4 },
    ]);
  });

  it('keeps every named loss in the postfix', () => {
    const line =
      'job:   2%|2| 5/250 [00:02<01:40, 2.4it/s, lr: 2.0e-04 loss: 1.000e-01 fft_loss: 2.500e-02]';
    expect(traceLossPoints(line)).toEqual([
      { step: 5, losses: { loss: 0.1, fft_loss: 0.025 }, lr: 2e-4 },
    ]);
  });

  it('parses tqdm text inside an events-mode log message', () => {
    const line = JSON.stringify({
      t: 1,
      type: 'log',
      epoch: 2,
      message: 'job:  40%|####| 80/200 [00:30<00:45, 2.6it/s, lr: 1.0e-04 loss: 9.100e-02]',
    });
    expect(traceLossPoints(line)).toEqual([{ step: 80, losses: { loss: 0.091 }, lr: 1e-4 }]);
  });

  it('reads a structured step event carrying a loss number or a loss map', () => {
    expect(
      traceLossPoints(
        JSON.stringify({ type: 'step', step: 7, maxSteps: 100, loss: 0.25, lr: 5e-5 })
      )
    ).toEqual([{ step: 7, losses: { loss: 0.25 }, lr: 5e-5 }]);
    expect(
      traceLossPoints('{"t":1700000000000,"type":"step","step":7,"seq":42,"loss":{"loss":0.31}}')
    ).toEqual([{ step: 7, losses: { loss: 0.31 }, lr: null }]);
  });

  it('reads the loss events the training worker writes', () => {
    const line =
      '{"t":1700000000000,"type":"loss","epoch":2,"step":20,"lr":0.0001,"loss":{"loss":0.3213}}';
    expect(traceLossPoints(line)).toEqual([{ step: 20, losses: { loss: 0.3213 }, lr: 1e-4 }]);
    expect(interpretTraceLine(line)).toEqual({ kind: 'loss' });
  });

  it('never files a learning rate as a loss', () => {
    expect(
      traceLossPoints(JSON.stringify({ type: 'step', step: 3, loss: { loss: 0.2, lr: 1e-4 } }))
    ).toEqual([{ step: 3, losses: { loss: 0.2 }, lr: null }]);
  });

  it('ignores lines that carry no loss', () => {
    expect(traceLossPoints(JSON.stringify({ type: 'step', step: 7, maxSteps: 100 }))).toEqual([]);
    expect(
      traceLossPoints('Generating Images: 100%|##########| 3/3 [00:10<00:00,  3.33s/it]')
    ).toEqual([]);
    expect(traceLossPoints('Saved checkpoint at 100% quality | 3 files')).toEqual([]);
    expect(traceLossPoints('job: 1/10 [00:01<00:09, 1.0it/s, lr: 1.0e-04 loss: nan]')).toEqual([]);
  });
});

describe('tracePath', () => {
  it('keys a trace by its path, not the presigned query', () => {
    expect(tracePath('https://o.civitai.com/v2/t/abc?sig=1&exp=2')).toBe(
      tracePath('https://o.civitai.com/v2/t/abc?sig=9&exp=3')
    );
  });
});

describe('followTrace', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('streams every line, including an unterminated last one, and reports completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('a\nb\n\nc'))
    );
    const lines: string[] = [];
    const attempt = await followTrace(
      () => 'https://x/t',
      (l) => lines.push(l),
      new AbortController().signal,
      () => true
    );
    expect(attempt).toBe('complete');
    expect(lines).toEqual(['a', 'b', 'c']);
  });

  it('stops on a 404 when told not to keep trying', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const attempt = await followTrace(
      () => 'https://x/t',
      () => {},
      new AbortController().signal,
      () => false
    );
    expect(attempt).toBe('missing');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a missing trace with the freshest URL until it arrives', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response('line'));
    vi.stubGlobal('fetch', fetchMock);
    let signature = 0;
    const lines: string[] = [];
    const done = followTrace(
      () => `https://x/t?sig=${++signature}`,
      (l) => lines.push(l),
      new AbortController().signal,
      () => true
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(await done).toBe('complete');
    expect(lines).toEqual(['line']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain(encodeURIComponent('sig=2'));
  });

  it('rejects with an abort during the retry backoff', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 }))
    );
    const controller = new AbortController();
    const done = followTrace(
      () => 'https://x/t',
      () => {},
      controller.signal,
      () => true
    );
    const assertion = expect(done).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await assertion;
  });
});
