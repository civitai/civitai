import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { detectEmptyLoopSeam } from '~/server/utils/animation-loop-seam';

const SIZE = 8;

const u24 = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]);
const chunk = (fourcc: string, payload: Buffer) => {
  const header = Buffer.alloc(8);
  header.write(fourcc, 0, 'ascii');
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload, Buffer.alloc(payload.length % 2)]);
};

// sharp 0.32 can decode animated WebP but not encode one from raw frames, so frames are
// encoded as static lossless WebPs and muxed into ANMF chunks by hand.
// Content is blue (red 0) so reading the first channel instead of alpha fails the seam case.
async function animatedWebp(frames: boolean[], { opaque = false } = {}) {
  const anmf = await Promise.all(
    frames.map(async (hasContent) => {
      const still = await sharp({
        create: {
          width: SIZE,
          height: SIZE,
          channels: opaque ? 3 : 4,
          background: hasContent
            ? { r: 0, g: 0, b: 255, alpha: 1 }
            : { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .webp({ lossless: true })
        .toBuffer();
      const vp8l = still.subarray(12);
      // x, y, width-1, height-1, duration, flags (0x02 = no blend, so a blank frame replaces the canvas)
      const header = Buffer.concat([
        u24(0),
        u24(0),
        u24(SIZE - 1),
        u24(SIZE - 1),
        u24(80),
        Buffer.from([0x02]),
      ]);
      return chunk('ANMF', Buffer.concat([header, vp8l]));
    })
  );
  const vp8x = chunk(
    'VP8X',
    Buffer.concat([Buffer.from([0x12, 0, 0, 0]), u24(SIZE - 1), u24(SIZE - 1)])
  );
  const anim = chunk('ANIM', Buffer.from([0, 0, 0, 0, 0, 0]));
  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), vp8x, anim, ...anmf]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

const detect = async (frames: boolean[], options?: { opaque?: boolean }) => {
  const buffer = await animatedWebp(frames, options);
  expect((await sharp(buffer).metadata()).pages).toBe(frames.length);
  return detectEmptyLoopSeam(buffer, frames.length);
};

describe('detectEmptyLoopSeam', () => {
  it('flags a single transparent frame appended after the last real frame', async () => {
    expect(await detect([true, true, true, false])).toBe(true);
  });

  it('passes an animation whose every frame has content', async () => {
    expect(await detect([true, true, true, true])).toBe(false);
  });

  it('passes a fade that starts empty, since the loop goes empty to empty', async () => {
    expect(await detect([false, true, true, false])).toBe(false);
  });

  it('reads an opaque animation without throwing', async () => {
    expect(await detect([true, true, true, true], { opaque: true })).toBe(false);
  });

  it('passes a deliberate run of empty frames at the end', async () => {
    expect(await detect([true, true, false, false])).toBe(false);
  });
});
