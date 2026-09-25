import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getVideoMetadata } from '~/utils/metadata';
import { readVideoTags } from '~/utils/metadata/video-tags';

const FIXTURES = join(__dirname, 'fixtures', 'video');
const bytes = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const expectedPrompt = JSON.stringify(
  JSON.parse(readFileSync(join(FIXTURES, 'prompt.json'), 'utf8'))
);
const expectedWorkflow = JSON.stringify(
  JSON.parse(readFileSync(join(FIXTURES, 'workflow.json'), 'utf8'))
);

/**
 * Counts reads and throws past a ceiling well above the walker's own budget, so a walker that
 * stopped bounding itself fails on the `slices` assertion instead of looping on microtasks
 * (in node, `slice().arrayBuffer()` never yields to timers, so vitest's timeout cannot fire).
 */
const SLICE_CEILING = 20_000;
class CountingBlob extends Blob {
  slices = 0;
  slice(...args: Parameters<Blob['slice']>) {
    if (++this.slices > SLICE_CEILING) throw new Error(`read ${this.slices} slices`);
    return super.slice(...args);
  }
}
const blob = (...parts: Uint8Array[]) => new CountingBlob(parts as BlobPart[]);
const WALKER_BUDGET = 10_000;
const FUZZ_OUTCOME = { variants: 2305, withTags: 1067 };

const TAGGED = ['vhs.mp4', 'core-faststart.mp4', 'core.webm', 'core.mkv'];
const UNTAGGED = ['plain.mp4', 'plain.webm'];

const encode = (s: string) => new TextEncoder().encode(s);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};
const u32 = (n: number) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
};

// #region mp4 builder
const box = (type: string | Uint8Array, ...body: Uint8Array[]) => {
  const payload = concat(...body);
  return concat(u32(8 + payload.length), typeof type === 'string' ? encode(type) : type, payload);
};
const ftyp = box('ftyp', encode('isom\0\0\0\0isom'));

function mp4WithTags(
  tags: [name: string, value: string, dataType?: number][],
  { fullBox = true, inUdta = true } = {}
) {
  const keyEntries = tags.map(([name]) => {
    const key = encode(`mdta${name}`);
    return concat(u32(4 + key.length), key);
  });
  const keys = box('keys', new Uint8Array(4), u32(tags.length), ...keyEntries);
  const items = tags.map(([, value, dataType = 1], i) =>
    box(u32(i + 1), box('data', u32(dataType), new Uint8Array(4), encode(value)))
  );
  const hdlr = box('hdlr', new Uint8Array(8), encode('mdta'), new Uint8Array(13));
  const meta = box(
    'meta',
    ...(fullBox ? [new Uint8Array(4)] : []),
    hdlr,
    keys,
    box('ilst', ...items)
  );
  return concat(ftyp, box('moov', inUdta ? box('udta', meta) : meta));
}
// #endregion

// #region matroska builder
const vintSize = (n: number) => {
  const out = new Uint8Array(8);
  out[0] = 0x01;
  let v = n;
  for (let i = 7; i > 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
};
const el = (id: number[], ...body: Uint8Array[]) => {
  const payload = concat(...body);
  return concat(new Uint8Array(id), vintSize(payload.length), payload);
};
const VOID = new Uint8Array([0xec, 0x80]);
const ID = {
  ebml: [0x1a, 0x45, 0xdf, 0xa3],
  segment: [0x18, 0x53, 0x80, 0x67],
  tags: [0x12, 0x54, 0xc3, 0x67],
  tag: [0x73, 0x73],
  simpleTag: [0x67, 0xc8],
  tagName: [0x45, 0xa3],
  tagString: [0x44, 0x87],
  segmentUnknownSize: new Uint8Array([
    0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  ]),
};
const simpleTag = (name: string, value: string, ...children: Uint8Array[]) =>
  el(ID.simpleTag, el(ID.tagName, encode(name)), el(ID.tagString, encode(value)), ...children);
const webmWithTags = (...simpleTags: Uint8Array[]) =>
  concat(el(ID.ebml), el(ID.segment, el(ID.tags, el(ID.tag, ...simpleTags))));
// #endregion

describe('readVideoTags', () => {
  it.each(TAGGED)('reads prompt and workflow from %s', async (name) => {
    expect(await readVideoTags(blob(bytes(name)))).toEqual({
      prompt: expectedPrompt,
      workflow: expectedWorkflow,
    });
  });

  it.each(UNTAGGED)('reads nothing from %s', async (name) => {
    expect(await readVideoTags(blob(bytes(name)))).toEqual({});
  });

  it.each(['core.webm', 'core-faststart.mp4'])(
    'keeps the tags of %s when the file is cut off after them',
    async (name) => {
      const original = bytes(name);
      const truncated = original.subarray(0, original.length - 400);
      expect(await readVideoTags(blob(truncated))).toEqual({
        prompt: expectedPrompt,
        workflow: expectedWorkflow,
      });
    }
  );

  it('reads a prompt-only tag from a streamed webm, whole or cut off after its tags', async () => {
    const original = bytes('live-prompt.webm');
    expect(await readVideoTags(blob(original))).toEqual({ prompt: expectedPrompt });
    expect(await readVideoTags(blob(original.subarray(0, original.length - 400)))).toEqual({
      prompt: expectedPrompt,
    });
  });

  it('reads nothing from a non-video file', async () => {
    expect(await readVideoTags(blob(encode('{"prompt":"x"}')))).toEqual({});
  });

  it.each([
    ['ISO full-box meta under udta', { fullBox: true, inUdta: true }],
    ['QuickTime plain-box meta under udta', { fullBox: false, inUdta: true }],
    ['meta directly under moov', { fullBox: true, inUdta: false }],
  ])('reads an mp4 with %s', async (_, layout) => {
    expect(await readVideoTags(blob(mp4WithTags([['prompt', 'hello']], layout)))).toEqual({
      prompt: 'hello',
    });
  });

  it('ignores mp4 values that are not UTF-8 text and keys it does not know', async () => {
    const file = mp4WithTags([
      ['prompt', 'binary', 0],
      ['comment', '{"prompt":"x"}'],
      ['workflow', 'wf'],
    ]);
    expect(await readVideoTags(blob(file))).toEqual({ workflow: 'wf' });
  });

  it('keeps the first of duplicate tags', async () => {
    const mp4 = mp4WithTags([
      ['prompt', 'first'],
      ['prompt', 'second'],
    ]);
    expect(await readVideoTags(blob(mp4))).toEqual({ prompt: 'first' });
    const webm = webmWithTags(simpleTag('PROMPT', 'first'), simpleTag('PROMPT', 'second'));
    expect(await readVideoTags(blob(webm))).toEqual({ prompt: 'first' });
  });
});

describe('getVideoMetadata', () => {
  it.each(TAGGED)('parses the ComfyUI graph in %s with the image parser', async (name) => {
    const meta = await getVideoMetadata(blob(bytes(name)));
    expect(meta).toMatchObject({
      prompt: 'a red fox running through snow; cinematic = 35mm # test',
      negativePrompt: 'blurry, lowres',
      steps: 20,
      cfgScale: 6.5,
      seed: 424242,
      width: 512,
      height: 320,
      models: ['exampleCheckpoint_v1.safetensors'],
      additionalResources: [
        { name: 'exampleLora_v2.safetensors', type: 'lora', strength: 0.8, strengthClip: 0.8 },
      ],
    });
    expect(meta?.comfy).toBeDefined();
  });

  it('parses a prompt-only (API-queued) run', async () => {
    expect(await getVideoMetadata(blob(bytes('live-prompt.webm')))).toMatchObject({
      prompt: 'a red fox running through snow; cinematic = 35mm # test',
      steps: 20,
    });
  });

  it.each(UNTAGGED)('returns undefined for %s', async (name) => {
    expect(await getVideoMetadata(blob(bytes(name)))).toBeUndefined();
  });

  it.each(['not json', 'null'])('returns undefined for a prompt tag of %s', async (value) => {
    expect(await getVideoMetadata(blob(mp4WithTags([['prompt', value]])))).toBeUndefined();
  });

  it('passes a graph with no nodes through as the package does for images', async () => {
    expect(await getVideoMetadata(blob(mp4WithTags([['prompt', '[]']])))).toEqual({
      comfy: '{"prompt": [], "workflow": undefined}',
      engine: 'ComfyUI',
    });
  });

  // Decision (coordinator, PR #5147): an oversized graph must not refuse the upload the way it
  // does for images; the video keeps its prompt and settings and loses only the `comfy` blob.
  // Do not "restore parity" with the image rejection without asking.
  it('drops only the comfy blob when the graph is over 1MB, keeping prompt and settings', async () => {
    const workflow = JSON.stringify({ nodes: [], pad: 'x'.repeat(1.2 * 1024 * 1024) });
    const meta = await getVideoMetadata(
      blob(
        mp4WithTags([
          ['prompt', expectedPrompt],
          ['workflow', workflow],
        ])
      )
    );
    expect(meta?.comfy).toBeUndefined();
    expect(meta).toMatchObject({
      prompt: 'a red fox running through snow; cinematic = 35mm # test',
      steps: 20,
      models: ['exampleCheckpoint_v1.safetensors'],
      additionalResources: [{ name: 'exampleLora_v2.safetensors', type: 'lora' }],
    });
  });
});

describe('readVideoTags on hostile input', () => {
  it('ignores an mp4 metadata box larger than the read cap', async () => {
    const small = blob(mp4WithTags([['prompt', 'hello']]));
    expect(await readVideoTags(small)).toEqual({ prompt: 'hello' });
    const huge = 'x'.repeat(9 * 1024 * 1024);
    expect(await readVideoTags(blob(mp4WithTags([['prompt', huge]])))).toEqual({});
  });

  it('ignores a matroska Tags element larger than the read cap', async () => {
    expect(await readVideoTags(blob(webmWithTags(simpleTag('PROMPT', 'hello'))))).toEqual({
      prompt: 'hello',
    });
    const huge = 'x'.repeat(9 * 1024 * 1024);
    expect(await readVideoTags(blob(webmWithTags(simpleTag('PROMPT', huge))))).toEqual({});
  });

  it('ignores a tag nested past the depth limit', async () => {
    let nested = simpleTag('PROMPT', 'deep');
    for (let i = 0; i < 10; i++) nested = simpleTag('WRAPPER', 'x', nested);
    expect(await readVideoTags(blob(webmWithTags(nested)))).toEqual({});
    const shallow = simpleTag('WRAPPER', 'x', simpleTag('PROMPT', 'shallow'));
    expect(await readVideoTags(blob(webmWithTags(shallow)))).toEqual({ prompt: 'shallow' });
  });

  it('shares one budget between the segment walk and the tag walk', async () => {
    const voids = (n: number) => concat(...Array.from({ length: n }, () => VOID));
    const junk = (n: number) =>
      el(ID.simpleTag, ...Array.from({ length: n }, () => el(ID.tagName, encode('x'))));
    const file = (before: number, inside: number) =>
      concat(
        el(ID.ebml),
        el(
          ID.segment,
          voids(before),
          el(ID.tags, el(ID.tag, junk(inside), simpleTag('PROMPT', 'p')))
        )
      );
    // 6k + 6k elements: under the budget for either walk alone, over it together.
    expect(await readVideoTags(blob(file(6_000, 6_000)))).toEqual({});
    expect(await readVideoTags(blob(file(100, 6_000)))).toEqual({ prompt: 'p' });
    expect(await readVideoTags(blob(file(6_000, 100)))).toEqual({ prompt: 'p' });
  });

  it('stops after its element budget on a matroska file of Void elements', async () => {
    const file = blob(
      el(ID.ebml),
      ID.segmentUnknownSize,
      ...Array.from({ length: 30_000 }, () => VOID)
    );
    expect(await readVideoTags(file)).toEqual({});
    expect(file.slices).toBeLessThanOrEqual(WALKER_BUDGET + 5);
  });

  it('walks past a valid 64-bit box to the tags after it', async () => {
    const largeFree = concat(u32(1), encode('free'), u32(0), u32(24), new Uint8Array(8));
    const tagged = mp4WithTags([['prompt', 'after-largesize']]);
    const file = blob(ftyp, largeFree, tagged.subarray(ftyp.length));
    expect(await readVideoTags(file)).toEqual({ prompt: 'after-largesize' });
  });

  it('stops after its element budget on a file of tiny boxes', async () => {
    const filler = concat(...Array.from({ length: 20_000 }, () => box('free')));
    const file = blob(ftyp, filler, mp4WithTags([['prompt', 'late']]).subarray(ftyp.length));
    expect(await readVideoTags(file)).toEqual({});
    expect(file.slices).toBeLessThanOrEqual(WALKER_BUDGET + 5);
  });

  it('stops on a 64-bit box whose size would not advance the walk', async () => {
    const file = blob(ftyp, u32(1), encode('free'), new Uint8Array(8));
    expect(await readVideoTags(file)).toEqual({});
    expect(file.slices).toBeLessThan(10);
  });

  it.each([
    ['a box size smaller than its header', concat(ftyp, u32(4), encode('moov'))],
    ['a box running past end of file', concat(ftyp, u32(0xfffffff0), encode('moov'))],
    ['a 64-bit box size of 2^53', concat(ftyp, u32(1), encode('moov'), u32(0x200000), u32(0))],
    ['an EBML header with no segment', new Uint8Array([...ID.ebml, 0x80])],
    [
      'an EBML segment of unknown size holding an unknown-size child',
      new Uint8Array([
        ...ID.ebml,
        0x80,
        ...ID.segment,
        0x01,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0x1f,
        0x43,
        0xb6,
        0x75,
        0xff,
      ]),
    ],
    ['an EBML id with no length marker', new Uint8Array([...ID.ebml, 0x80, 0x00, 0x00])],
  ])('returns no tags for %s, in a handful of reads', async (_, bytes) => {
    const file = blob(bytes);
    expect(await readVideoTags(file)).toEqual({});
    expect(file.slices).toBeLessThan(10);
  });

  it('returns only known string tags, within budget, for every truncation and corruption', async () => {
    let seed = 1;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const variants: Uint8Array[] = [];
    for (const name of TAGGED) {
      const original = bytes(name);
      for (let length = 0; length < original.length; length += 7)
        variants.push(original.subarray(0, length));
      for (let i = 0; i < 200; i++) {
        const corrupt = original.slice();
        for (let j = 0; j < 8; j++)
          corrupt[Math.floor(random() * corrupt.length)] = Math.floor(random() * 256);
        variants.push(corrupt);
      }
    }
    let maxSlices = 0;
    let withTags = 0;
    for (const variant of variants) {
      const file = blob(variant);
      const tags = await readVideoTags(file);
      maxSlices = Math.max(maxSlices, file.slices);
      if (Object.keys(tags).length) withTags++;
    }
    expect(maxSlices).toBeLessThanOrEqual(WALKER_BUDGET + 5);
    // Pinned from a run at the commit that added it: how many of the seeded variants still yield
    // tags. A change to any bound or size check moves it; regenerating a fixture legitimately
    // does too, so re-pin it then.
    expect({ variants: variants.length, withTags }).toEqual(FUZZ_OUTCOME);
  });
});
