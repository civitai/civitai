import { describe, expect, it, vi } from 'vitest';
import type { AutoLabelItem, AutoLabelResult } from './backend';

const submitted: AutoLabelItem[] = [];
vi.mock('$lib/host', () => ({
  backend: () => ({
    autoLabelSubmit: async (items: AutoLabelItem[]) => {
      submitted.push(...items);
      return { workflowId: 'wf' };
    },
    autoLabelPoll: async () => ({
      done: true,
      results: submitted.map((i) => ({ key: i.key, status: 'succeeded' })),
    }),
  }),
}));

const { runAutoLabel, MAX_SUBMITS_PER_MEDIA } = await import('./autolabel');

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
      { key: '0', status: 'failed' },
      { key: '1', status: 'failed' },
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
});
