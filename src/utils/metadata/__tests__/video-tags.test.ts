import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getVideoMetadata } from '~/utils/metadata';
import { readVideoTags } from '~/utils/metadata/video-tags';

const FIXTURES = join(__dirname, 'fixtures', 'video');
const bytes = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const blob = (...parts: Uint8Array[]) => new Blob(parts as BlobPart[]);
const expectedPrompt = JSON.stringify(
  JSON.parse(readFileSync(join(FIXTURES, 'prompt.json'), 'utf8'))
);
const expectedWorkflow = JSON.stringify(
  JSON.parse(readFileSync(join(FIXTURES, 'workflow.json'), 'utf8'))
);

const TAGGED = ['vhs.mp4', 'core-faststart.mp4', 'core.webm', 'core.mkv'];
const UNTAGGED = ['plain.mp4', 'plain.webm', 'nomovflags.mp4'];

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
    expect(await readVideoTags(blob(new TextEncoder().encode('{"prompt":"x"}')))).toEqual({});
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

  it.each(UNTAGGED)('returns undefined for %s', async (name) => {
    expect(await getVideoMetadata(blob(bytes(name)))).toBeUndefined();
  });
});

describe('readVideoTags on hostile input', () => {
  const box = (type: string, body: Uint8Array | number[] = []) => {
    const payload = body instanceof Uint8Array ? body : new Uint8Array(body);
    const out = new Uint8Array(8 + payload.length);
    new DataView(out.buffer).setUint32(0, out.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(payload, 8);
    return out;
  };
  const concat = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  };
  const ftyp = box('ftyp', new TextEncoder().encode('isom\0\0\0\0isom'));

  function mp4WithPrompt(prompt: string) {
    const key = new TextEncoder().encode('mdtaprompt');
    const keyEntry = concat(new Uint8Array([0, 0, 0, 8 + key.length - 4]), key);
    const keys = box('keys', concat(new Uint8Array(4), new Uint8Array([0, 0, 0, 1]), keyEntry));
    const data = box(
      'data',
      concat(new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0]), new TextEncoder().encode(prompt))
    );
    const item = concat(box('\0\0\0\x01', data));
    const ilst = box('ilst', item);
    const hdlr = box(
      'hdlr',
      concat(new Uint8Array(8), new TextEncoder().encode('mdta'), new Uint8Array(13))
    );
    const meta = box('meta', concat(new Uint8Array(4), hdlr, keys, ilst));
    return concat(ftyp, box('moov', box('udta', meta)));
  }

  it('the hand-built mp4 helper is readable, so the cases below fail for their stated reason', async () => {
    expect(await readVideoTags(blob(mp4WithPrompt('hello')))).toEqual({ prompt: 'hello' });
  });

  it('ignores a metadata box larger than the read cap', async () => {
    const huge = 'x'.repeat(9 * 1024 * 1024);
    expect(await readVideoTags(blob(mp4WithPrompt(huge)))).toEqual({});
  });

  it('stops walking after the box budget instead of scanning a file of tiny boxes', async () => {
    const filler = new Uint8Array(20_000 * 8);
    for (let i = 0; i < 20_000; i++) filler.set(box('free'), i * 8);
    const file = concat(ftyp, filler, mp4WithPrompt('late').subarray(ftyp.length));
    const started = performance.now();
    expect(await readVideoTags(blob(file))).toEqual({});
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it.each([
    [
      'a box size smaller than its header',
      concat(ftyp, new Uint8Array([0, 0, 0, 4, 0x6d, 0x6f, 0x6f, 0x76])),
    ],
    [
      'a box running past end of file',
      concat(ftyp, new Uint8Array([0xff, 0xff, 0xff, 0xf0, 0x6d, 0x6f, 0x6f, 0x76])),
    ],
    [
      'a 64-bit box size of 2^53',
      concat(ftyp, new Uint8Array([0, 0, 0, 1, 0x6d, 0x6f, 0x6f, 0x76, 0, 0x20, 0, 0, 0, 0, 0, 0])),
    ],
    ['an EBML header with no segment', new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x80])],
    [
      'an EBML segment of unknown size holding an unknown-size child',
      new Uint8Array([
        0x1a, 0x45, 0xdf, 0xa3, 0x80, 0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xff, 0x1f, 0x43, 0xb6, 0x75, 0xff,
      ]),
    ],
    [
      'an EBML id with no length marker',
      new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x80, 0x00, 0x00]),
    ],
  ])('returns no tags for %s', async (_, file) => {
    expect(await readVideoTags(blob(file))).toEqual({});
  });

  it('terminates on every truncation and on random corruption of each fixture', async () => {
    let seed = 1;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const started = performance.now();
    let runs = 0;
    for (const name of TAGGED) {
      const original = bytes(name);
      for (let length = 0; length < original.length; length += 7) {
        await readVideoTags(blob(original.subarray(0, length)));
        runs++;
      }
      for (let i = 0; i < 200; i++) {
        const corrupt = original.slice();
        for (let j = 0; j < 8; j++)
          corrupt[Math.floor(random() * corrupt.length)] = Math.floor(random() * 256);
        await readVideoTags(blob(corrupt));
        runs++;
      }
    }
    expect(runs).toBeGreaterThan(1_000);
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});
