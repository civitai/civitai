import { describe, expect, it, vi } from 'vitest';
import { toReuseItems } from './reuse';

// train-core (for trainingBlobKey) loads the SDK, whose dist Node's ESM loader refuses.
vi.mock('@civitai/orchestration-client', () => ({}));

describe('toReuseItems', () => {
  it("gives an edit run's starting image the sample URL the run already sent for it", () => {
    const items = toReuseItems(
      [
        {
          air: 'urn:air:flux2:image:civitai:blob@KEYA.png',
          caption: '',
          path: 'control_1/pair_1.png',
        },
        { air: 'urn:air:flux2:image:civitai:blob@KEYB.png', caption: 'x', path: 'main/pair_1.png' },
        {
          air: 'urn:air:flux2:image:civitai:blob@KEYC.png',
          caption: '',
          path: 'control_1/pair_2.png',
        },
      ],
      'wf-1',
      ['https://orch.example/v2/consumer/blobs/keya.png?sig=1']
    );
    expect(items.map((i) => i.url)).toEqual([
      'https://orch.example/v2/consumer/blobs/keya.png?sig=1',
      undefined,
      undefined,
    ]);
    expect(items[0]).toMatchObject({ path: 'control_1/pair_1.png', workflowId: 'wf-1' });
  });
});
