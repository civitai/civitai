import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutoLabelItem, AutoLabelResult } from './backend';

const submitted: AutoLabelItem[] = [];
const refuse = { message: '' };
// What the next submit throws instead of succeeding; `refuse.message` is the legacy plain-Error form.
const failWith: { err: Error | null } = { err: null };
const host = { available: true };
vi.mock('$lib/host', () => ({
  autoLabelAvailable: () => host.available,
  backend: () => ({
    autoLabelSubmit: async (items: AutoLabelItem[]) => {
      if (failWith.err) throw failWith.err;
      if (refuse.message) throw new Error(refuse.message);
      submitted.push(...items);
      return { workflowId: 'wf' };
    },
    autoLabelPoll: async () => ({
      done: true,
      results: submitted.map((i) => ({ key: i.key, status: 'succeeded' })),
    }),
  }),
}));

const { runAutoLabel, MAX_SUBMITS_PER_MEDIA, CAP_REFUSAL } = await import('./autolabel');
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
