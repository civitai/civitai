import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { getMetadata } from '~/utils/metadata';

// A minimal ComfyUI API-format graph: checkpoint -> two text encodes -> KSampler <- empty latent.
const PROMPT_GRAPH = {
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'dreamshaper_8.safetensors' } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 768, batch_size: 1 } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a lighthouse at dusk', clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry', clip: ['4', 1] } },
  '3': {
    class_type: 'KSampler',
    inputs: {
      seed: 1234,
      steps: 20,
      cfg: 7,
      sampler_name: 'euler',
      scheduler: 'normal',
      denoise: 1,
      model: ['4', 0],
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: ['5', 0],
    },
  },
  '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'ComfyUI' } },
};
const WORKFLOW_GRAPH = { last_node_id: 9, last_link_id: 9, nodes: [], links: [], version: 0.4 };
const A1111_PARAMS =
  'a lighthouse at dusk\nNegative prompt: blurry\nSteps: 20, Sampler: Euler, CFG scale: 7, Seed: 1234, Size: 512x768';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Uint8Array) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
const latin1 = (s: string) => Buffer.from(s, 'latin1');
const utf8 = (s: string) => Buffer.from(s, 'utf8');
const NUL = Buffer.from([0]);

type TextChunk = { key: string; value: string; kind: 'tEXt' | 'iTXt' | 'iTXt-z' | 'zTXt' };
function textChunk({ key, value, kind }: TextChunk) {
  if (kind === 'tEXt') return chunk('tEXt', Buffer.concat([latin1(key), NUL, latin1(value)]));
  if (kind === 'zTXt')
    return chunk('zTXt', Buffer.concat([latin1(key), NUL, NUL, deflateSync(latin1(value))]));
  const compressed = kind === 'iTXt-z';
  const text = compressed ? deflateSync(utf8(value)) : utf8(value);
  // keyword\0 compressionFlag compressionMethod languageTag\0 translatedKeyword\0 text
  return chunk(
    'iTXt',
    Buffer.concat([latin1(key), NUL, Buffer.from([compressed ? 1 : 0, 0]), NUL, NUL, text])
  );
}

function png(texts: TextChunk[]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const idat = deflateSync(Buffer.from([0, 255, 255, 255]));
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...texts.map(textChunk),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array()),
  ]);
  // A File, as the upload preprocessor receives it.
  return new File([bytes], 'ComfyUI_00001_.png', { type: 'image/png' });
}

const comfyChunks = (kind: TextChunk['kind']): TextChunk[] => [
  { key: 'prompt', value: JSON.stringify(PROMPT_GRAPH), kind },
  { key: 'workflow', value: JSON.stringify(WORKFLOW_GRAPH), kind },
];

function expectGenerationData(meta: Record<string, unknown>) {
  expect(meta).toMatchObject({
    prompt: 'a lighthouse at dusk',
    negativePrompt: 'blurry',
    seed: 1234,
    steps: 20,
    cfgScale: 7,
  });
}

describe('generation metadata read from an uploaded file (getMetadata)', () => {
  it.each(['tEXt', 'iTXt', 'iTXt-z', 'zTXt'] as const)(
    'reads prompt/workflow from %s chunks',
    async (kind) => {
      expectGenerationData(await getMetadata(png(comfyChunks(kind))));
    }
  );

  it.each(['tEXt', 'iTXt-z', 'zTXt'] as const)(
    'reads A1111 parameters from %s chunks',
    async (kind) => {
      expectGenerationData(
        await getMetadata(png([{ key: 'parameters', value: A1111_PARAMS, kind }]))
      );
    }
  );

  it('reads A1111 parameters from a JPEG EXIF UserComment', async () => {
    // A1111 layout: "UNICODE\0" then UTF-16BE text, in ExifIFD tag 0x9286.
    const text = Buffer.from(A1111_PARAMS, 'utf16le').swap16();
    const comment = Buffer.concat([latin1('UNICODE\0'), text]);
    const tiff = Buffer.alloc(44);
    tiff.write('II*\0', 0, 'latin1');
    tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(1, 8); // IFD0: one entry
    tiff.writeUInt16LE(0x8769, 10); // ExifIFD pointer
    tiff.writeUInt16LE(4, 12); // LONG
    tiff.writeUInt32LE(1, 14);
    tiff.writeUInt32LE(26, 18);
    tiff.writeUInt16LE(1, 26); // ExifIFD: one entry
    tiff.writeUInt16LE(0x9286, 28); // UserComment
    tiff.writeUInt16LE(7, 30); // UNDEFINED
    tiff.writeUInt32LE(comment.length, 32);
    tiff.writeUInt32LE(44, 36);
    const app1 = Buffer.concat([latin1('Exif\0\0'), tiff, comment]);
    const app1Head = Buffer.from([0xff, 0xe1, 0, 0]);
    app1Head.writeUInt16BE(app1.length + 2, 2);
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      app1Head,
      app1,
      Buffer.from([0xff, 0xd9]),
    ]);
    const file = new File([jpeg], '00001-1234.jpg', { type: 'image/jpeg' });
    expectGenerationData(await getMetadata(file));
  });

  it('negative control: a PNG with no text chunks yields no generation data', async () => {
    expect(await getMetadata(png([]))).toEqual({});
  });
});
