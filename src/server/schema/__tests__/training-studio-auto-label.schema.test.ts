import { describe, expect, it } from 'vitest';
import { studioAutoLabelSubmitSchema } from '~/server/schema/training-studio-auto-label.schema';

// What the Training Studio Data step sends as mediaUrl: a fresh upload's orchestrator URL, or, for a
// Train again / Reuse a dataset tile, the browser object URL its preview hydrated to. The studio keeps
// the second kind out of auto-label (`canAutoLabelImage`); this pins why.
const FRESH_UPLOAD = 'https://orchestration.civitai.com/v2/consumer/blobs/abc123.jpeg?sig=x&exp=1';
const REUSED_OBJECT_URL = 'blob:https://training.civitai.com/3f9a1c2e-7b1d-4e0a-9c55-2d0c8f6b1e77';

const submit = (mediaUrl: string) =>
  studioAutoLabelSubmitSchema.safeParse({
    mode: 'tag',
    media: 'image',
    items: [{ key: '0', mediaUrl }],
  });

describe('studioAutoLabelSubmitSchema mediaUrl', () => {
  it('accepts a fresh upload URL', () => {
    expect(submit(FRESH_UPLOAD).success).toBe(true);
  });

  it('refuses a browser object URL', () => {
    const result = submit(REUSED_OBJECT_URL);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join('.'))).toEqual(['items.0.mediaUrl']);
  });
});
