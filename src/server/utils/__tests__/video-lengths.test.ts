import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ebml, mp4Box, mp4Clip, mp4Words, webmClip } from '~/server/utils/__tests__/zip-fixture';
import { readVideoLengths } from '~/server/utils/video-lengths';

const FIXTURES = join(__dirname, '../../../utils/metadata/__tests__/fixtures/video');
const fixture = (name: string) => readFileSync(join(FIXTURES, name));
const spread = (lengths: number[] | null) => lengths && Math.max(...lengths) - Math.min(...lengths);

describe('readVideoLengths', () => {
  it.each(['plain.mp4', 'core-faststart.mp4', 'plain.webm', 'core.mkv'])(
    'reads a real %s as one agreed length',
    (name) => {
      const lengths = readVideoLengths(fixture(name));
      expect(lengths?.length).toBeGreaterThan(1);
      expect(Math.max(...lengths!)).toBeCloseTo(0.75, 2);
      expect(spread(lengths)).toBeLessThan(1);
    }
  );

  it('reports the sample table of an mp4 whose headers claim less', () => {
    const lengths = readVideoLengths(mp4Clip({ seconds: 60, headerSeconds: 20 }));
    expect(Math.min(...lengths!)).toBe(20);
    expect(Math.max(...lengths!)).toBe(60);
  });

  it('reports the last block of a webm whose Info claims less, clusters of unknown size included', () => {
    for (const unknownSize of [false, true]) {
      const lengths = readVideoLengths(
        webmClip({ declared: 20, blocks: [0, 30, 60], unknownSize })
      );
      expect(lengths).toEqual([20, 60]);
    }
  });

  it('reads a webm with no declared length from its blocks', () => {
    expect(readVideoLengths(webmClip({ blocks: [0, 12] }))).toEqual([12]);
  });

  const clip = mp4Clip({ seconds: 10 });
  const moovAt = clip.indexOf('moov') - 4;
  const withSize = (bytes: Buffer, at: number, size: number) => {
    const copy = Buffer.from(bytes);
    copy.writeUInt32BE(size, at);
    return copy;
  };
  it.each([
    ['truncated', clip.subarray(0, clip.length - 30)],
    ['a box larger than the file', withSize(clip, moovAt, clip.length * 2)],
    ['a box smaller than its own header', withSize(clip, moovAt, 4)],
    ['a webm cut off mid-cluster', webmClip({ blocks: [0, 5] }).subarray(0, -3)],
    ['a fragmented mp4', Buffer.concat([clip, mp4Box('moof', mp4Box('mfhd', mp4Words(0, 1)))])],
    [
      'a sample table that misses samples',
      Buffer.from(clip)
        .fill(0, clip.indexOf('stsz') + 12, clip.indexOf('stsz') + 15)
        .fill(9, clip.indexOf('stsz') + 15, clip.indexOf('stsz') + 16),
    ],
    ['bytes that are neither', Buffer.from('not a video at all, just text')],
  ])('refuses %s', (_name, bytes) => {
    expect(readVideoLengths(bytes)).toBeNull();
  });

  it('refuses a file of more boxes than it will visit, without hanging', () => {
    const empty = mp4Box('free');
    const many = Buffer.concat([clip, Buffer.concat(Array(1_000_001).fill(empty))]);
    const started = Date.now();
    expect(readVideoLengths(many)).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('walks a deeply nested element without recursing', () => {
    let nested: Buffer = ebml(0xa3, Buffer.from([0x81, 0, 0, 0x80]));
    for (let i = 0; i < 10_000; i++) nested = ebml(0xa0, nested);
    const bytes = Buffer.concat([
      ebml(0x1a45dfa3, ebml(0x4282, Buffer.from('webm'))),
      ebml(0x18538067, ebml(0x1f43b675, Buffer.concat([ebml(0xe7, Buffer.from([0])), nested]))),
    ]);
    expect(readVideoLengths(bytes)).toBeNull();
  });
});
