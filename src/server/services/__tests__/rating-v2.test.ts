import { beforeEach, describe, expect, it, vi } from 'vitest';

const orch = vi.hoisted(() => ({ submitWorkflow: vi.fn() }));
vi.mock('@civitai/orchestration-client', async () => ({
  ...(
    await import('~/server/services/orchestrator/__tests__/civitai-client.stub')
  ).civitaiClientStub(),
  submitWorkflow: orch.submitWorkflow,
}));

import { matureLevelOf, rateImagesV2 } from '~/server/services/rating-v2.service';

const items = [
  { key: 'a', mediaUrl: 'https://orchestration.civitai.com/v2/consumer/blobs/A-0.png' },
  { key: 'b', mediaUrl: 'https://orchestration.civitai.com/v2/consumer/blobs/B-0.png' },
];
const rate = () =>
  rateImagesV2({ items, matureLevel: 2, metadata: { kind: 'test' }, tags: [], waitSeconds: 1 });

describe('rateImagesV2', () => {
  beforeEach(() => orch.submitWorkflow.mockReset());

  it('restricted counts as mature whatever the sexual level', async () => {
    orch.submitWorkflow.mockResolvedValue({
      data: {
        steps: [
          {
            name: '0',
            status: 'succeeded',
            output: { ratingV2: { status: 'ok', sexual: { label: 'S0' }, restricted: true } },
          },
          {
            name: '1',
            status: 'succeeded',
            output: { ratingV2: { status: 'ok', sexual: { label: 'S1' }, restricted: false } },
          },
        ],
      },
    });
    expect(await rate()).toEqual([
      { key: 'a', mature: true },
      { key: 'b', mature: false },
    ]);
  });

  it('a level at the cut-off is mature', async () => {
    orch.submitWorkflow.mockResolvedValue({
      data: {
        steps: [
          {
            name: '0',
            status: 'succeeded',
            output: { ratingV2: { status: 'ok', sexual: { label: 'S2' }, restricted: false } },
          },
        ],
      },
    });
    expect((await rate())[0]).toEqual({ key: 'a', mature: true });
  });
});

describe('rateImagesV2 wire shape', () => {
  beforeEach(() => orch.submitWorkflow.mockReset());

  it('one imageScanning step per item on the v2 rater, free to the user', async () => {
    orch.submitWorkflow.mockResolvedValue({ data: { steps: [] } });
    await rate();
    const call = orch.submitWorkflow.mock.calls[0][0];
    expect(call.query).toEqual({ wait: 1 });
    expect(call.body.currencies).toEqual([]);
    expect(call.body.steps).toEqual([
      expect.objectContaining({
        $type: 'imageScanning',
        name: '0',
        input: { image: items[0].mediaUrl, 'rater-model': 'radio-alpha' },
      }),
      expect.objectContaining({
        $type: 'imageScanning',
        name: '1',
        input: { image: items[1].mediaUrl, 'rater-model': 'radio-alpha' },
      }),
    ]);
  });

  it('a failed step or a rating that is not ok gives no verdict', async () => {
    orch.submitWorkflow.mockResolvedValue({
      data: {
        steps: [
          {
            name: '0',
            status: 'failed',
            output: { ratingV2: { status: 'ok', sexual: { label: 'S4' }, restricted: true } },
          },
          {
            name: '1',
            status: 'succeeded',
            output: { ratingV2: { status: 'error', sexual: { label: 'S4' }, restricted: true } },
          },
        ],
      },
    });
    expect(await rate()).toEqual([
      { key: 'a', mature: null },
      { key: 'b', mature: null },
    ]);
  });
});

describe('matureLevelOf', () => {
  it('reads s1-s4 and nothing else', () => {
    expect(matureLevelOf('s2')).toBe(2);
    expect(matureLevelOf(' S4 ')).toBe(4);
    expect(matureLevelOf('off')).toBeNull();
    expect(matureLevelOf('s0')).toBeNull();
    expect(matureLevelOf(null)).toBeNull();
  });
});
