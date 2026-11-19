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

  it('reads a movie padded with a great many boxes in good time', () => {
    const padding = Buffer.concat(Array(400_000).fill(mp4Box('free')));
    const started = Date.now();
    readVideoLengths(Buffer.concat([clip, padding]));
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('refuses a file of more boxes than it will visit, without hanging', () => {
    const empty = mp4Box('free');
    const many = Buffer.concat([clip, Buffer.concat(Array(1_000_001).fill(empty))]);
    const started = Date.now();
    expect(readVideoLengths(many)).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('reports an edit list that plays longer than the samples', () => {
    expect(Math.max(...readVideoLengths(mp4Clip({ seconds: 10, editSeconds: 70 }))!)).toBe(70);
  });

  it('reads an mp4 whose mdat has a 64-bit size', () => {
    expect(readVideoLengths(mp4Clip({ seconds: 10, largeMdat: true }))).toContain(10);
  });

  const nanDuration = () => {
    const clip = webmClip({ declared: 20, blocks: [0, 600] });
    const at = clip.indexOf(Buffer.from([0x44, 0x89])) + 10;
    clip.writeDoubleBE(NaN, at);
    return clip;
  };
  /** A first cluster whose last child claims to run on over the whole of the next cluster. */
  const childPastParent = () => {
    const block = ebml(0xa3, Buffer.from([0x81, 0, 0, 0x80, 0]));
    const timecode = (ms: number) =>
      ebml(0xe7, Buffer.from([ms >> 16, (ms >> 8) & 0xff, ms & 0xff]));
    const second = ebml(0x1f43b675, Buffer.concat([timecode(600_000), block]));
    const overrun = ebml(0xec, second).subarray(0, 9); // a Void header sized over `second`
    const first = ebml(0x1f43b675, Buffer.concat([timecode(0), block, overrun]));
    return Buffer.concat([
      ebml(0x1a45dfa3, ebml(0x4282, Buffer.from('webm'))),
      ebml(0x18538067, Buffer.concat([first, second])),
    ]);
  };
  it.each([
    ['a webm whose Duration is NaN', nanDuration],
    ['a webm element that runs past its parent', childPastParent],
    ['an mp4 marked fragmented in its moov', () => mp4Clip({ mvex: true })],
  ])('refuses %s', (_name, bytes) => {
    expect(readVideoLengths(bytes())).toBeNull();
  });
});

describe('readVideoLengths, on what a player could show and it would not measure', () => {
  const w = mp4Words;
  const B = mp4Box;
  const ftyp = B('ftyp', Buffer.from('isom', 'latin1'), w(0x200));
  const stts = (seconds: number) => B('stts', w(0, 1, 1, Math.round(seconds * 1000)));
  const trak = (
    seconds: number,
    { handler = 'vide', stbl = [stts(seconds)], edits = [] as Buffer[], samples = 1 } = {}
  ) =>
    B(
      'trak',
      B('tkhd', w(0, 0, 0, 1, 0, seconds * 1000), Buffer.alloc(60)),
      ...edits,
      B(
        'mdia',
        B('mdhd', w(0, 0, 0, 1000, seconds * 1000, 0)),
        B('hdlr', w(0, 0), Buffer.from(handler, 'latin1'), Buffer.alloc(12)),
        B('minf', B('stbl', ...stbl, B('stsz', w(0, 4, samples))))
      )
    );
  const movie = (traks: Buffer[], extra: Buffer[] = []) =>
    Buffer.concat([
      ftyp,
      B('moov', B('mvhd', w(0, 0, 0, 1000, 10_000), Buffer.alloc(80)), ...traks, ...extra),
      B('mdat', Buffer.alloc(4)),
    ]);
  const elst = (...entries: [number, number][]) =>
    B('edts', B('elst', w(0, entries.length, ...entries.flatMap(([d, t]) => [d, t, 0x10000]))));

  it('reads a plain one-track movie (the control for the cases below)', () => {
    expect(readVideoLengths(movie([trak(10)]))).toEqual([10, 10, 10, 10]);
    expect(readVideoLengths(movie([trak(10, { edits: [elst([10_000, 0])] })]))).toContain(10);
    expect(readVideoLengths(movie([trak(10), trak(10, { handler: 'soun' })]))).not.toBeNull();
  });

  it.each([
    ['a second timing table', () => movie([trak(10, { stbl: [stts(10), stts(600)] })])],
    ['a second video track', () => movie([trak(10), trak(10)])],
    ['two media edits', () => movie([trak(10, { edits: [elst([5000, 0], [5000, 0])] })])],
    [
      'an edit table whose count runs past its box',
      () => movie([trak(10, { edits: [B('edts', B('elst', w(0, 50, 10_000, 0, 0x10000)))] })]),
    ],
    [
      'a timing table whose count runs past its box',
      // The missing second entry would be read from stsz's header: 20 more samples.
      () => movie([trak(10, { stbl: [B('stts', w(0, 2, 1, 10_000))], samples: 21 })]),
    ],
    [
      'cover art',
      () => movie([trak(10)], [B('udta', B('meta', w(0), B('ilst', B('covr', w(0)))))]),
    ],
    [
      'a composition offset past a second',
      () => movie([trak(10, { stbl: [stts(10), B('ctts', w(0, 1, 1, 5000))] })]),
    ],
    ['a second moov', () => Buffer.concat([movie([trak(10)]), B('moov')])],
  ])('refuses an mp4 with %s', (_n, bytes) => {
    expect(readVideoLengths(bytes())).toBeNull();
  });

  const head = ebml(0x1a45dfa3, ebml(0x4282, Buffer.from('webm')));
  const info = (ms: number, scale = [0x0f, 0x42, 0x40]) => {
    const f = Buffer.alloc(8);
    f.writeDoubleBE(ms);
    return ebml(0x1549a966, Buffer.concat([ebml(0x2ad7b1, Buffer.from(scale)), ebml(0x4489, f)]));
  };
  const cluster = (ms: number) => {
    const tc = Buffer.alloc(4);
    tc.writeUInt32BE(ms);
    return ebml(
      0x1f43b675,
      Buffer.concat([ebml(0xe7, tc), ebml(0xa3, Buffer.from([0x81, 0, 0, 0x80, 0]))])
    );
  };
  const track = (type: number, extra: Buffer[] = []) =>
    ebml(0xae, Buffer.concat([ebml(0x83, Buffer.from([type])), ...extra]));
  const tracks = (...entries: Buffer[]) => ebml(0x1654ae6b, Buffer.concat(entries));
  const webm = (...children: Buffer[]) =>
    Buffer.concat([head, ebml(0x18538067, Buffer.concat(children))]);
  const one = Buffer.alloc(8);
  one.writeDoubleBE(1);
  const ten = Buffer.alloc(4);
  ten.writeFloatBE(10);

  it('reads a plain webm with a video and an audio track (the control for the cases below)', () => {
    expect(
      readVideoLengths(
        webm(
          info(10_000),
          tracks(track(1, [ebml(0x23314f, one)]), track(2)),
          cluster(0),
          cluster(10_000)
        )
      )
    ).toEqual([10, 10]);
  });

  it.each([
    [
      'a second Info',
      () => webm(info(6000), cluster(0), cluster(60_000), info(60_000, [0x01, 0x86, 0xa0])),
    ],
    [
      'a second video track',
      () => webm(info(10_000), tracks(track(1), track(1)), cluster(0), cluster(10_000)),
    ],
    [
      'a track time scale',
      () => webm(info(5000), tracks(track(1, [ebml(0x23314f, ten)])), cluster(0), cluster(5000)),
    ],
    [
      'bytes after its Segment',
      () =>
        Buffer.concat([
          webm(info(5000), cluster(0), cluster(5000)),
          webm(info(600_000), cluster(600_000)),
        ]),
    ],
    [
      'attachments',
      () => webm(info(10_000), ebml(0x1941a469, Buffer.alloc(4)), cluster(0), cluster(10_000)),
    ],
    [
      'a cluster with two timecodes',
      () => {
        const block = ebml(0xa3, Buffer.from([0x81, 0, 0, 0x80, 0]));
        const at = (ms: number) => ebml(0xe7, Buffer.from([ms >> 16, (ms >> 8) & 0xff, ms & 0xff]));
        return webm(
          info(10_000),
          ebml(0x1f43b675, Buffer.concat([at(0), block, at(60_000), block]))
        );
      },
    ],
  ])('refuses a webm with %s', (_n, bytes) => {
    expect(readVideoLengths(bytes())).toBeNull();
  });
});
