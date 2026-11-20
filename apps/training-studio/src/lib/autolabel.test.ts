import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutoLabelItem, AutoLabelResult } from './backend';

const submitted: AutoLabelItem[] = [];
const refuse = { message: '' };
// What the next submit throws instead of succeeding; `refuse.message` is the legacy plain-Error form.
const failWith: { err: Error | null } = { err: null };
const host = { available: true };
// When set, answers each workflow's poll from its items and how often each was sent before.
const plan: {
  poll: ((items: AutoLabelItem[], attempt: number) => AutoLabelResult[]) | null;
  inFlight: number;
  maxInFlight: number;
} = { poll: null, inFlight: 0, maxInFlight: 0 };
const workflows = new Map<string, { items: AutoLabelItem[]; attempt: number }>();
const sendsByUrl = new Map<string, number>();
vi.mock('$lib/host', () => ({
  autoLabelAvailable: () => host.available,
  backend: () => ({
    autoLabelSubmit: async (items: AutoLabelItem[]) => {
      if (failWith.err) throw failWith.err;
      if (refuse.message) throw new Error(refuse.message);
      submitted.push(...items);
      if (!plan.poll) return { workflowId: 'wf' };
      const attempt = Math.max(...items.map((i) => sendsByUrl.get(i.mediaUrl) ?? 0));
      for (const i of items) sendsByUrl.set(i.mediaUrl, (sendsByUrl.get(i.mediaUrl) ?? 0) + 1);
      const id = `wf-${workflows.size}`;
      workflows.set(id, { items, attempt });
      plan.maxInFlight = Math.max(plan.maxInFlight, ++plan.inFlight);
      return { workflowId: id };
    },
    autoLabelPoll: async (workflowId: string) => {
      const wf = workflows.get(workflowId);
      if (!plan.poll || !wf)
        return { done: true, results: submitted.map((i) => ({ key: i.key, status: 'succeeded' })) };
      // One pending read first, so every batch the client started is open at the same time.
      await new Promise((r) => setTimeout(r, 0));
      plan.inFlight--;
      return { done: true, results: plan.poll(wf.items, wf.attempt) };
    },
  }),
}));

const { runAutoLabel, MAX_SUBMITS_PER_MEDIA, CAP_REFUSAL, BUSY_RETRY_DELAYS_MS, BUSY_GAVE_UP } =
  await import('./autolabel');
const { AutoLabelRefusedError } = await import('./autolabel-errors');

describe('auto-label per-image submit cap', () => {
  it('stops sending an image that keeps being re-requested, and fails it instead', async () => {
    const items = [
      { key: '0', mediaUrl: 'https://x/a.png' },
      { key: '1', mediaUrl: 'https://x/b.png' },
    ];
    const sentPerRun: number[] = [];
    const lastResults: AutoLabelResult[] = [];
    // A caller stuck re-selecting the same tiles, as the loop did.
    for (let run = 0; run < MAX_SUBMITS_PER_MEDIA + 2; run++) {
      lastResults.length = 0;
      sentPerRun.push(
        await runAutoLabel(
          'caption',
          'image',
          items,
          (r) => lastResults.push(r),
          new AbortController().signal
        )
      );
    }

    expect(sentPerRun.slice(MAX_SUBMITS_PER_MEDIA)).toEqual([0, 0]);
    for (const url of ['https://x/a.png', 'https://x/b.png'])
      expect(submitted.filter((i) => i.mediaUrl === url)).toHaveLength(MAX_SUBMITS_PER_MEDIA);
    expect(lastResults).toEqual([
      { key: '0', status: 'failed', error: CAP_REFUSAL },
      { key: '1', status: 'failed', error: CAP_REFUSAL },
    ]);
  });

  it('counts a re-signed URL for the same blob against the same cap', async () => {
    const sent: number[] = [];
    for (let run = 0; run < MAX_SUBMITS_PER_MEDIA + 1; run++) {
      const item = { key: '0', mediaUrl: `https://x/c.png?sig=${run}` };
      sent.push(
        await runAutoLabel('caption', 'image', [item], () => {}, new AbortController().signal)
      );
    }
    expect(sent.at(-1)).toBe(0);
  });

  it("fails a refused batch with the server's reason, so the tile can show it", async () => {
    refuse.message = 'Auto-label only accepts media uploaded to Civitai.';
    try {
      const results: AutoLabelResult[] = [];
      await runAutoLabel(
        'caption',
        'image',
        [{ key: 'r', mediaUrl: 'https://x/refused.png' }],
        (r) => results.push(r),
        new AbortController().signal
      );
      expect(results).toEqual([{ key: 'r', status: 'failed', error: refuse.message }]);
    } finally {
      refuse.message = '';
    }
  });
});

describe('auto-label cap accounting for failed submits', () => {
  const run = async (url: string) => {
    const results: AutoLabelResult[] = [];
    const sent = await runAutoLabel(
      'caption',
      'image',
      [{ key: 'k', mediaUrl: url }],
      (r) => results.push(r),
      new AbortController().signal
    );
    return { sent, results };
  };
  const attempts = async (url: string, tries: number) => {
    const out = [];
    for (let i = 0; i < tries; i++) out.push(await run(url));
    return out;
  };
  afterEach(() => {
    failWith.err = null;
    host.available = true;
  });

  it('does not spend the cap on a submit refused before any orchestrator work', async () => {
    failWith.err = new AutoLabelRefusedError('Auto-labeling is unavailable right now.');
    const tries = await attempts('https://x/refused-slot.png', MAX_SUBMITS_PER_MEDIA + 3);
    // Never told "Auto-labeled 3 times already": each try reaches the backend and gets its reason.
    for (const t of tries) {
      expect(t.sent).toBe(1);
      expect(t.results).toEqual([
        { key: 'k', status: 'failed', error: 'Auto-labeling is unavailable right now.' },
      ]);
    }
    failWith.err = null;
    expect((await run('https://x/refused-slot.png')).sent).toBe(1);
  });

  it('keeps counting a submit that may have been charged', async () => {
    // A network drop after send, or a 5xx with no refusal marker: the workflow may exist.
    failWith.err = new Error('auto-label submit failed (503)');
    const tries = await attempts('https://x/maybe-charged.png', MAX_SUBMITS_PER_MEDIA + 1);
    expect(tries.map((t) => t.sent)).toEqual([1, 1, 1, 0]);
    expect(tries.at(-1)?.results).toEqual([{ key: 'k', status: 'failed', error: CAP_REFUSAL }]);
  });

  it('refunds only the refused try, not slots earlier successes used', async () => {
    const url = 'https://x/mixed.png';
    await run(url); // success: 1 slot
    failWith.err = new AutoLabelRefusedError('nope');
    await run(url); // refused: no slot
    failWith.err = null;
    // 1 slot used => 2 more successes, then the cap.
    expect((await attempts(url, MAX_SUBMITS_PER_MEDIA)).map((t) => t.sent)).toEqual([1, 1, 0]);
  });

  it('sends nothing, and claims no slot, where the host has no auto-label', async () => {
    host.available = false;
    const before = submitted.length;
    const { sent, results } = await run('https://x/standalone.png');
    expect(sent).toBe(0);
    expect(results).toEqual([
      { key: 'k', status: 'failed', error: 'Auto-labeling is unavailable right now.' },
    ]);
    expect(submitted).toHaveLength(before);
    host.available = true;
    expect(
      (await attempts('https://x/standalone.png', MAX_SUBMITS_PER_MEDIA)).map((t) => t.sent)
    ).toEqual([1, 1, 1]);
  });
});

describe('auto-label under load', () => {
  const items = (n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => ({ key: `${i}`, mediaUrl: `https://x/${tag}-${i}.png` }));
  const busy = (i: AutoLabelItem): AutoLabelResult => ({
    key: i.key,
    status: 'failed',
    error: 'Auto-labeling is busy right now.',
    retryable: true,
  });
  const ok = (i: AutoLabelItem): AutoLabelResult => ({
    key: i.key,
    status: 'succeeded',
    tags: ['t'],
  });
  const run = async (list: AutoLabelItem[], signal = new AbortController().signal) => {
    const results: AutoLabelResult[] = [];
    const done = runAutoLabel('tag', 'image', list, (r) => results.push(r), signal);
    return { results, done };
  };
  afterEach(() => {
    plan.poll = null;
    plan.inFlight = plan.maxInFlight = 0;
    vi.useRealTimers();
  });

  it('runs at most two batches at once instead of all of them', async () => {
    plan.poll = (list) => list.map(ok);
    const { results, done } = await run(items(80, 'load'));
    await done;
    expect(results).toHaveLength(80);
    expect(plan.maxInFlight).toBe(2);
  });

  it('sends an item turned away for capacity again after a wait, and labels it', async () => {
    vi.useFakeTimers();
    plan.poll = (list, attempt) =>
      list.map((i) => (attempt < 2 && i.key === '1' ? busy(i) : ok(i)));
    const { results, done } = await run(items(3, 'busy'));
    await vi.runAllTimersAsync();
    await done;
    expect(results.find((r) => r.key === '1')).toEqual({
      key: '1',
      status: 'succeeded',
      tags: ['t'],
    });
    expect(results.filter((r) => r.status === 'failed')).toEqual([]);
    expect(sendsByUrl.get('https://x/busy-1.png')).toBe(3);
  });

  it('gives up after its retries with a reason, and Retry stays under the cap', async () => {
    vi.useFakeTimers();
    plan.poll = (list) => list.map(busy);
    const url = 'https://x/always-busy.png';
    const { results, done } = await run([{ key: 'k', mediaUrl: url }]);
    await vi.runAllTimersAsync();
    await done;
    expect(sendsByUrl.get(url)).toBe(BUSY_RETRY_DELAYS_MS.length + 1);
    expect(results).toEqual([{ key: 'k', status: 'failed', error: BUSY_GAVE_UP }]);
    // The resends shared the first send's slot; the run that gave up still spent it.
    vi.useRealTimers();
    plan.poll = (list) => list.map(ok);
    const sent: number[] = [];
    for (let i = 0; i < MAX_SUBMITS_PER_MEDIA; i++)
      sent.push(await (await run([{ key: 'k', mediaUrl: url }])).done);
    expect(sent).toEqual([...Array(MAX_SUBMITS_PER_MEDIA - 1).fill(1), 0]);
  });

  it('resends only items marked retryable, and keeps the slot of one that ran', async () => {
    vi.useFakeTimers();
    plan.poll = (list) => list.map((i) => ({ key: i.key, status: 'failed', error: 'x' }));
    const url = 'https://x/ran-and-failed.png';
    const sent: number[] = [];
    for (let i = 0; i <= MAX_SUBMITS_PER_MEDIA; i++) {
      const { done } = await run([{ key: 'k', mediaUrl: url }]);
      await vi.runAllTimersAsync();
      sent.push(await done);
    }
    expect(sent).toEqual([1, 1, 1, 0]);
    expect(sendsByUrl.get(url)).toBe(MAX_SUBMITS_PER_MEDIA);
  });

  it('stops waiting to resend when the run is aborted, and gives the slot back', async () => {
    vi.useFakeTimers();
    plan.poll = (list) => list.map(busy);
    const controller = new AbortController();
    const url = 'https://x/aborted.png';
    const { results, done } = await run([{ key: 'k', mediaUrl: url }], controller.signal);
    const settled = done.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1);
    // Parked in the resend wait: polled once, one timer (the wait) left.
    expect(sendsByUrl.get(url)).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    await expect(settled).resolves.toMatchObject({ name: 'AbortError' });
    expect(results).toEqual([]);
    vi.useRealTimers();
    plan.poll = (list) => list.map(ok);
    const sent: number[] = [];
    for (let i = 0; i < MAX_SUBMITS_PER_MEDIA; i++)
      sent.push(await (await run([{ key: 'k', mediaUrl: url }])).done);
    expect(sent).toEqual(Array(MAX_SUBMITS_PER_MEDIA).fill(1));
  });
});
