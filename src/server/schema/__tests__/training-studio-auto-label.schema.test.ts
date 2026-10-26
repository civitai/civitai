import { describe, expect, it } from 'vitest';
import { submitStudioAutoLabelSchema } from '~/server/schema/training.schema';

const image = (i: number) => ({ mediaUrl: `https://x/${i}.mp3`, filename: `k${i}` });

describe('submitStudioAutoLabelSchema', () => {
  it('rejects audio in tag mode, which wdTagging cannot process', () => {
    const input = { mediaType: 'audio', images: [image(0)], params: { type: 'tag' } };
    expect(submitStudioAutoLabelSchema.safeParse(input).success).toBe(false);
  });

  it('accepts audio in caption mode', () => {
    const input = { mediaType: 'audio', images: [image(0)], params: { type: 'caption' } };
    expect(submitStudioAutoLabelSchema.safeParse(input).success).toBe(true);
  });

  it('caps a batch at 16 images', () => {
    const images = Array.from({ length: 17 }, (_, i) => image(i));
    const input = { mediaType: 'image', images, params: { type: 'tag' } };
    expect(submitStudioAutoLabelSchema.safeParse(input).success).toBe(false);
  });
});
