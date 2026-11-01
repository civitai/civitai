import { describe, expect, it } from 'vitest';
import {
  BLOCK_TRAINING_SAMPLE_PROMPTS_MAX,
  blockTrainingBodySchema,
  blockTrainingDatasetItemsSchema,
  blockWorkflowBodySchema,
} from '../workflow.schema';
import { findForeignTrainingBlobKeys, trainingBlobKeyFromAir } from '../training-dataset.schema';

/**
 * The `kind:'training'` wire body. `.strict()` with NO `maxBuzz` and no timeout
 * knob: the price is the server's stored quote, never an app-supplied number. Its
 * dataset is the Training Studio's `{ air, caption }` items, each `air` reduced to
 * the bare consumer-blob key.
 */

const PARAMS = {
  engine: 'ai-toolkit',
  ecosystem: 'sdxl',
  epochs: 5,
  resolution: 1024,
  lr: 0.0001,
  textEncoderLr: null,
  trainTextEncoder: false,
  lrScheduler: 'cosine',
  optimizerType: 'adamw8bit',
  networkDim: 32,
  networkAlpha: 16,
  noiseOffset: null,
  minSnrGamma: null,
  flipAugmentation: false,
  shuffleTokens: false,
  keepTokens: 0,
};

const BLOB_URL = 'https://orchestration.civitai.com/v2/consumer/blobs/E8S6FBPH50ENNVF2PD5.jpeg';

const BODY = {
  kind: 'training',
  items: [
    { air: `${BLOB_URL}?sig=abc`, caption: 'a' },
    { air: 'CXJQSCS1TYZR1PX45C7QBVB8E0.jpeg', caption: 'b' },
  ],
  engine: 'ai-toolkit',
  model: 'sdxl',
  params: PARAMS,
  triggerWord: 'mychar',
  samplePrompts: ['mychar on a beach'],
};

describe('blockTrainingBodySchema', () => {
  it('parses a valid body through the OUTER union, as the training member', () => {
    const parsed = blockWorkflowBodySchema.parse(BODY);
    expect(parsed.kind).toBe('training');
  });

  it('reduces every item to its bare blob key — the url form and the key form alike', () => {
    expect(blockTrainingBodySchema.parse(BODY).items).toEqual([
      { air: 'E8S6FBPH50ENNVF2PD5.jpeg', caption: 'a' },
      { air: 'CXJQSCS1TYZR1PX45C7QBVB8E0.jpeg', caption: 'b' },
    ]);
  });

  it('accepts a submit body naming a quote', () => {
    expect(
      blockTrainingBodySchema.safeParse({ ...BODY, quoteId: `tq_${'b'.repeat(32)}` }).success
    ).toBe(true);
  });

  it.each([
    ['a maxBuzz knob', { maxBuzz: 100 }],
    ['a timeout knob', { timeout: '01:00:00' }],
    ['an image count', { imageCount: 3 }],
    ['a dataset handle', { datasetId: `tds_${'a'.repeat(32)}` }],
    ['inline training data', { trainingData: { type: 'blobs', items: [] } }],
  ])('rejects %s (strict)', (_l, extra) => {
    expect(blockWorkflowBodySchema.safeParse({ ...BODY, ...extra }).success).toBe(false);
  });

  it.each([
    ['no items', { items: [] }],
    ['51 items', { items: Array.from({ length: 51 }, (_, i) => ({ air: `K${i}`, caption: '' })) }],
    ['a malformed quoteId', { quoteId: 'tq_../x' }],
    ['another engine', { engine: 'kohya' }],
    ['an over-long trigger word', { triggerWord: 'x'.repeat(65) }],
    [
      'too many sample prompts',
      { samplePrompts: Array(BLOCK_TRAINING_SAMPLE_PROMPTS_MAX + 1).fill('p') },
    ],
    ['an over-long sample prompt', { samplePrompts: ['x'.repeat(1001)] }],
    ['an unknown ecosystem', { params: { ...PARAMS, ecosystem: 'notreal' } }],
    ['a variant the ecosystem requires missing', { params: { ...PARAMS, ecosystem: 'flux1' } }],
    ['an lr the training form refuses', { params: { ...PARAMS, lr: 0.5 } }],
  ])('rejects %s', (_l, over) => {
    expect(blockWorkflowBodySchema.safeParse({ ...BODY, ...over }).success).toBe(false);
  });

  it('accepts exactly the item and sample-prompt maxima (boundary controls)', () => {
    expect(
      blockTrainingBodySchema.safeParse({
        ...BODY,
        items: Array.from({ length: 50 }, (_, i) => ({ air: `K${i}`, caption: '' })),
        samplePrompts: Array(BLOCK_TRAINING_SAMPLE_PROMPTS_MAX).fill('p'),
      }).success
    ).toBe(true);
  });

  it('leaves the other kinds parsing unchanged', () => {
    expect(
      blockWorkflowBodySchema.safeParse({
        kind: 'step',
        $type: 'imageGen',
        input: {},
        maxBuzz: 10,
      }).success
    ).toBe(true);
    expect(
      blockWorkflowBodySchema.safeParse({
        kind: 'textToImage',
        modelId: 1,
        modelVersionId: 2,
        params: { prompt: 'a cat', quantity: 1 },
      }).success
    ).toBe(true);
  });
});

describe('blockTrainingDatasetItemsSchema', () => {
  const items = (...airs: string[]) => airs.map((air) => ({ air, caption: '' }));
  const parses = (value: unknown) => blockTrainingDatasetItemsSchema.safeParse(value).success;

  it.each([
    ['a url on another host', 'https://example.com/v2/consumer/blobs/K1.jpeg'],
    ['a plain-http blob url', 'http://orchestration.civitai.com/v2/consumer/blobs/K1.jpeg'],
    ['a civitai url outside the blob path', 'https://image.civitai.com/K1.jpeg'],
    ['a blob url with a deeper path', `${BLOB_URL}/x`],
    ['a key with a path separator', 'a/b'],
    ['an orchestrator AIR', 'urn:air:sdxl:lora:orchestrator:blob@K1'],
    ['an empty air', ''],
  ])('refuses %s', (_l, air) => {
    expect(parses(items(air))).toBe(false);
  });

  it('refuses one blob named twice, however it is spelled or cased', () => {
    expect(parses(items('E8S6FBPH50ENNVF2PD5.jpeg', `${BLOB_URL}?sig=1`))).toBe(false);
    expect(parses(items('k1.jpeg', 'K1.JPEG'))).toBe(false);
    expect(parses(items('K1.jpeg', 'K2.jpeg'))).toBe(true);
  });

  it('caps a caption at the orchestrator’s 8,192 characters, and refuses another key', () => {
    expect(parses([{ air: 'K1', caption: 'x'.repeat(8192) }])).toBe(true);
    expect(parses([{ air: 'K1', caption: 'x'.repeat(8193) }])).toBe(false);
    expect(parses([{ air: 'K1', caption: '', imageId: 1 }])).toBe(false);
  });
});

describe('trainingBlobKeyFromAir / findForeignTrainingBlobKeys', () => {
  it('reads the key out of the upload url, dropping the query', () => {
    expect(trainingBlobKeyFromAir(`${BLOB_URL}?sig=abc&exp=1`)).toBe('E8S6FBPH50ENNVF2PD5.jpeg');
    expect(trainingBlobKeyFromAir('K1')).toBe('K1');
    expect(trainingBlobKeyFromAir('https://evil.example/v2/consumer/blobs/K1')).toBeNull();
  });

  it('never reads an image CDN url or an upload key as a blob', () => {
    const key = 'ab12cd34-ef56-4a7b-8c9d-0e1f2a3b4c5d';
    expect(
      trainingBlobKeyFromAir(
        `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${key}/original=true`
      )
    ).toBeNull();
    expect(trainingBlobKeyFromAir(key)).toBeNull();
    const items = [{ air: `https://image.civitai.com/x/${key}/original=true`, caption: '' }];
    expect(blockTrainingDatasetItemsSchema.safeParse(items).success).toBe(false);
    // Control: the same item naming a blob parses.
    expect(blockTrainingDatasetItemsSchema.safeParse([{ air: 'K1', caption: '' }]).success).toBe(
      true
    );
  });

  it('reports the quoted keys an uploader did not upload, case-insensitively', () => {
    expect(findForeignTrainingBlobKeys(['K1.jpeg', 'K2.jpeg'], ['k1.JPEG', 'k2.jpeg'])).toEqual([]);
    expect(findForeignTrainingBlobKeys(['K1.jpeg', 'K2.jpeg'], ['K1.jpeg'])).toEqual(['K2.jpeg']);
    expect(findForeignTrainingBlobKeys(['K1.jpeg'], [])).toEqual(['K1.jpeg']);
  });

  it('never reads a malformed key list as "nothing foreign"', () => {
    expect(findForeignTrainingBlobKeys(undefined, ['K1'])).not.toEqual([]);
    expect(findForeignTrainingBlobKeys([7], ['7'])).toEqual(['7']);
  });
});
