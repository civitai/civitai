import { describe, expect, it } from 'vitest';

import { VideoMetadataParser } from '~/utils/metadata';

const encoder = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function uint32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function uint64(value: number): Uint8Array {
  const result = new Uint8Array(8);
  new DataView(result.buffer).setBigUint64(0, BigInt(value));
  return result;
}

function mp4Box(
  type: string | Uint8Array,
  payload = new Uint8Array(),
  extended = false
): Uint8Array {
  const typeBytes = typeof type === 'string' ? encoder.encode(type) : type;
  if (extended) {
    return concat(uint32(1), typeBytes, uint64(payload.length + 16), payload);
  }
  return concat(uint32(payload.length + 8), typeBytes, payload);
}

function mp4Fixture(
  metadata: Record<string, string>,
  options: { extended?: boolean; mediaFirst?: boolean } = {}
): Blob {
  const entries = Object.entries(metadata);
  const keyEntries = entries.map(([key]) =>
    concat(uint32(8 + encoder.encode(key).length), encoder.encode('mdta'), encoder.encode(key))
  );
  const keys = mp4Box(
    'keys',
    concat(new Uint8Array(4), uint32(entries.length), ...keyEntries),
    options.extended
  );
  const items = entries.map(([, value], index) => {
    const data = mp4Box(
      'data',
      concat(new Uint8Array([0, 0, 0, 1]), new Uint8Array(4), encoder.encode(value)),
      options.extended
    );
    return mp4Box(uint32(index + 1), data, options.extended);
  });
  const ilst = mp4Box('ilst', concat(...items), options.extended);
  const meta = mp4Box('meta', concat(new Uint8Array(4), keys, ilst), options.extended);
  const moov = mp4Box('moov', mp4Box('udta', meta, options.extended), options.extended);
  const ftyp = mp4Box('ftyp', concat(encoder.encode('isom'), uint32(0), encoder.encode('isom')));
  const mdat = mp4Box('mdat', new Uint8Array([1, 2, 3, 4]));
  return new Blob(options.mediaFirst ? [ftyp, mdat, moov] : [ftyp, moov, mdat], {
    type: 'video/mp4',
  });
}

const ebmlIds = {
  header: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]),
  segment: new Uint8Array([0x18, 0x53, 0x80, 0x67]),
  tags: new Uint8Array([0x12, 0x54, 0xc3, 0x67]),
  tag: new Uint8Array([0x73, 0x73]),
  simpleTag: new Uint8Array([0x67, 0xc8]),
  tagName: new Uint8Array([0x45, 0xa3]),
  tagString: new Uint8Array([0x44, 0x87]),
};

function ebmlSize(value: number, width?: number): Uint8Array {
  const sizeWidth =
    width ?? Array.from({ length: 8 }, (_, i) => i + 1).find((x) => value < 2 ** (7 * x) - 1);
  if (!sizeWidth) throw new Error('fixture value is too large');
  const result = new Uint8Array(sizeWidth);
  let remaining = value;
  for (let i = sizeWidth - 1; i >= 0; i--) {
    result[i] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  result[0] |= 1 << (8 - sizeWidth);
  return result;
}

function ebmlElement(id: Uint8Array, payload = new Uint8Array(), sizeWidth?: number): Uint8Array {
  return concat(id, ebmlSize(payload.length, sizeWidth), payload);
}

function simpleTag(name: string, value: string, nested?: Uint8Array): Uint8Array {
  return ebmlElement(
    ebmlIds.simpleTag,
    concat(
      ebmlElement(ebmlIds.tagName, encoder.encode(name)),
      ebmlElement(ebmlIds.tagString, encoder.encode(value), 2),
      nested ?? new Uint8Array()
    )
  );
}

function webmFixture(
  metadata: Record<string, string>,
  options: { unknownSegment?: boolean; nested?: boolean } = {}
): Blob {
  let tags = Object.entries(metadata).map(([name, value]) => simpleTag(name, value));
  if (options.nested && tags[0]) {
    tags = [
      ebmlElement(
        ebmlIds.simpleTag,
        concat(ebmlElement(ebmlIds.tagName, encoder.encode('PARENT')), tags[0])
      ),
      ...tags.slice(1),
    ];
  }
  const tag = ebmlElement(ebmlIds.tag, concat(...tags));
  const tagsElement = ebmlElement(ebmlIds.tags, tag);
  const segment = options.unknownSegment
    ? concat(
        ebmlIds.segment,
        new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
        tagsElement
      )
    : ebmlElement(ebmlIds.segment, tagsElement, 4);
  return new Blob([ebmlElement(ebmlIds.header), segment], { type: 'video/webm' });
}

const prompt = JSON.stringify({
  '1': {
    class_type: 'KSampler',
    inputs: {
      seed: 123,
      steps: 20,
      cfg: 7,
      sampler_name: 'euler',
      scheduler: 'normal',
      denoise: 1,
      positive: ['2', 0],
      negative: ['3', 0],
      latent_image: ['4', 0],
      model: ['5', 0],
    },
  },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: 'video prompt' } },
  '3': { class_type: 'CLIPTextEncode', inputs: { text: 'video negative' } },
  '4': { class_type: 'EmptyLatentImage', inputs: { width: 640, height: 480 } },
  '5': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
});
const workflow = JSON.stringify({
  nodes: [],
  extra: { airs: ['urn:air:sd1:checkpoint:civitai:12@34'] },
});

async function expectComfyMetadata(file: Blob) {
  const parser = await VideoMetadataParser(file);
  const parsed = parser.parse();
  const metadata = await parser.getMetadata();

  expect(parser.exif.prompt).toBe(prompt);
  expect(parser.exif.workflow).toBe(workflow);
  expect(parsed).toMatchObject({
    prompt: 'video prompt',
    negativePrompt: 'video negative',
    seed: 123,
    steps: 20,
    sampler: 'Euler',
    width: 640,
    height: 480,
  });
  expect(parsed?.civitaiResources).toEqual([{ modelVersionId: 0, type: 'model' }]);
  expect(metadata).toMatchObject({
    prompt: 'video prompt',
    negativePrompt: 'video negative',
    seed: 123,
    steps: 20,
  });
}

describe('VideoMetadataParser MP4', () => {
  it('maps lowercase mdta keys to Comfy metadata', async () => {
    await expectComfyMetadata(mp4Fixture({ prompt, workflow }));
  });

  it('recognizes mdta keys case-insensitively and decodes extraMetadata JSON', async () => {
    const parser = await VideoMetadataParser(
      mp4Fixture({
        PrOmPt: prompt,
        WoRkFlOw: workflow,
        ExTrAmEtAdAtA: JSON.stringify({
          prompt: 'Eclipse override',
          sampler: 'Euler',
          resources: [],
        }),
      })
    );
    expect(parser.exif.extraMetadata).toEqual({
      prompt: 'Eclipse override',
      sampler: 'Euler',
      resources: [],
    });
    expect(parser.parse()).toMatchObject({ prompt: 'Eclipse override', sampler: 'Euler' });
  });

  it('supports 64-bit boxes and moov metadata after media data', async () => {
    await expectComfyMetadata(
      mp4Fixture({ prompt, workflow }, { extended: true, mediaFirst: true })
    );
  });

  it('passes Automatic parameters through the existing processor', async () => {
    const parser = await VideoMetadataParser(
      mp4Fixture({
        parameters: 'an mp4 prompt\nNegative prompt: blur\nSteps: 12, Sampler: Euler, CFG scale: 5',
      })
    );
    expect(parser.parse()).toMatchObject({
      prompt: 'an mp4 prompt',
      negativePrompt: 'blur',
      steps: '12',
      sampler: 'Euler',
    });
  });

  it('returns no metadata for missing tags or malformed box sizes', async () => {
    const missing = await VideoMetadataParser(mp4Fixture({ title: 'not generation metadata' }));
    expect(await missing.getMetadata()).toEqual({});

    const malformed = new Blob([
      mp4Box('ftyp', encoder.encode('isom')),
      concat(uint32(4), encoder.encode('moov')),
    ]);
    const parser = await VideoMetadataParser(malformed);
    expect(parser.exif).toEqual({});
    expect(await parser.getMetadata()).toEqual({});
  });

  it('rejects oversized individual and combined metadata without rejecting the file', async () => {
    const individual = await VideoMetadataParser(
      mp4Fixture({ prompt: 'x'.repeat(2 * 1024 * 1024 + 1) })
    );
    expect(individual.exif).toEqual({});

    const chunk = 'x'.repeat(1024 * 1024 + 1);
    const combined = await VideoMetadataParser(
      mp4Fixture({ prompt: chunk, workflow: chunk, parameters: chunk, extraMetadata: chunk })
    );
    expect(combined.exif).toEqual({});
  });
});

describe('VideoMetadataParser WebM', () => {
  it('normalizes uppercase FFmpeg tags and variable-length element sizes', async () => {
    await expectComfyMetadata(webmFixture({ PROMPT: prompt, WORKFLOW: workflow }));
  });

  it('supports unknown-size segments and nested SimpleTag elements', async () => {
    await expectComfyMetadata(
      webmFixture({ PROMPT: prompt, WORKFLOW: workflow }, { unknownSegment: true, nested: true })
    );
  });

  it('recognizes tags case-insensitively', async () => {
    const parser = await VideoMetadataParser(
      webmFixture({
        PaRaMeTeRs: 'a webm prompt\nSteps: 8, Sampler: Euler',
      })
    );
    expect(parser.parse()).toMatchObject({ prompt: 'a webm prompt', steps: '8', sampler: 'Euler' });
  });

  it('returns no metadata for malformed input and payload limit violations', async () => {
    const malformed = await VideoMetadataParser(
      new Blob([ebmlElement(ebmlIds.header), concat(ebmlIds.segment, new Uint8Array([0x81, 0xff]))])
    );
    expect(malformed.exif).toEqual({});

    const oversized = await VideoMetadataParser(
      webmFixture({ PROMPT: 'x'.repeat(2 * 1024 * 1024 + 1) })
    );
    expect(oversized.exif).toEqual({});

    const chunk = 'x'.repeat(1024 * 1024 + 1);
    const combined = await VideoMetadataParser(
      webmFixture({ PROMPT: chunk, WORKFLOW: chunk, PARAMETERS: chunk, EXTRAMETADATA: chunk })
    );
    expect(combined.exif).toEqual({});
  });
});
