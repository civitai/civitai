import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { checkAppStepResources } from '~/server/services/blocks/app-step-resources';

const VIEWER = 7;
const OWNER = 8;
const MODERATOR = 9;
const published = { status: 'Published', availability: 'Public', model: { userId: OWNER } };
const VERSIONS = [
  { id: 10, baseModel: 'SDXL 1.0', ...published },
  { id: 11, baseModel: 'SDXL Turbo', ...published },
  { id: 100, baseModel: 'Flux.2 D', ...published },
  { id: 20, baseModel: 'SDXL 1.0', ...published, availability: 'Private' },
  { id: 21, baseModel: 'SDXL 1.0', ...published, status: 'Draft' },
  { id: 22, baseModel: 'SDXL 1.0', ...published, status: 'Training' },
  { id: 23, baseModel: 'SDXL 1.0', ...published, usageControl: 'InternalGeneration' },
  { id: 24, baseModel: 'SDXL 1.0', ...published, status: 'UnpublishedViolation' },
  { id: 25, baseModel: 'SDXL 1.0', ...published, status: 'Scheduled' },
  { id: 26, baseModel: 'SDXL 1.0', ...published, status: 'Unpublished' },
];
const civitai = (versionId: number) => `urn:air:sdxl:lora:civitai:1@${versionId}`;
const check = (input: unknown, viewerId = VIEWER) => checkAppStepResources(input, viewerId);
const checkWorkflow = (body: unknown) => checkAppStepResources(body, VIEWER, { workflow: true });
// The two workflow arms pass the whole body and say so; every other arm passes a step input.
const checkAny = (input: unknown) =>
  input &&
  typeof input === 'object' &&
  'steps' in input &&
  'arguments' in input &&
  Array.isArray((input as { steps: unknown }).steps)
    ? checkWorkflow(input)
    : check(input);

beforeEach(() => {
  dbMock.dbRead.modelVersion.findMany.mockClear();
  dbMock.dbRead.user.findUnique.mockReset();
  dbMock.dbRead.user.findUnique.mockImplementation((async ({
    where,
  }: {
    where: { id: number };
  }) => ({ isModerator: where.id === MODERATOR })) as never);
  dbMock.dbRead.modelVersion.findMany.mockImplementation((async ({
    where,
  }: {
    where: { id: { in: number[] } };
  }) => VERSIONS.filter((v) => where.id.in.includes(v.id))) as never);
});

describe('checkAppStepResources', () => {
  it.each([
    ['an AIR', { model: 'urn:air:flux2:diffusion_model:huggingface:org/repo@main/x.safetensors' }],
    ['a URL deep in the input', { a: [{ b: 'https://huggingface.co/org/repo/x.safetensors' }] }],
    [
      'an AIR with surrounding whitespace',
      { model: ' urn:air:sdxl:lora:huggingface:org/repo@main ' },
    ],
  ])('refuses a Hugging Face resource given as %s', async (_, input) => {
    await expect(check(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each([
    ['another source', { model: 'urn:air:sdxl:checkpoint:modelscope:org/repo@1' }],
    ['another source without the urn prefix', { model: 'sdxl:checkpoint:modelscope:org/repo@1' }],
    ['another source in short form', { model: 'modelscope:org/repo@1' }],
    ['a version that does not exist', { model: civitai(99) }],
    ['a URL to a weights file', { model: 'https://example.com/weights/model.safetensors?x=1' }],
    ['a URL as a map key', { loras: { 'https://example.com/lora': 1 } }],
    ['a weights URL with an encoded path', { model: 'https://example.com/m%2Esafetensors#x' }],
    ['a weights URL under another scheme', { model: 's3://bucket/model.safetensors' }],
    ['a weights URL without its slashes', { model: 'https:example.com/model.gguf' }],
    ['an AIR the parser cannot read', { model: 'urn:air:sdxl:checkpoint:civitai:1@2 extra' }],
    ['another source as a map key', { loras: { 'modelscope:org/repo': 1 } }],
  ])('refuses %s', async (_, input) => {
    await expect(check(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each([
    ['a Civitai AIR without a version', 'urn:air:sdxl:lora:civitai:1'],
    ['a Civitai AIR with a malformed version', 'urn:air:sdxl:lora:civitai:1@0'],
  ])('refuses %s before looking it up', async (_, model) => {
    await expect(check({ model })).rejects.toThrow(/must name a model version/);
    expect(dbMock.dbRead.modelVersion.findMany).not.toHaveBeenCalled();
  });

  it('refuses a version on a base model no app may use', async () => {
    await expect(check({ model: civitai(100) })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it.each([
    ['an AIR', { model: civitai(11) }],
    ['a file-pinned AIR', { model: `${civitai(11)}+22` }],
    ['a short-form AIR', { model: 'civitai:1@11' }],
    ['a LoRA map key', { loras: { [civitai(11)]: 0.8 } }],
  ])(
    'caps a step naming a version on a base model that restricts mature generation as %s',
    async (_, input) => {
      await expect(check(input)).resolves.toEqual({ capOutput: true });
    }
  );

  it('allows a training-data zip from a Hugging Face dataset repo', async () => {
    await expect(
      check({
        sourceUrl:
          'urn:air:other:other:huggingface:datasets/Civitai/orchestration-samples@e86d02/sample-training-dataset.zip',
      })
    ).resolves.toEqual({ capOutput: false });
  });

  it.each([
    ['as weights', 'urn:air:sdxl:checkpoint:huggingface:datasets/org/repo@main/model.zip'],
    [
      'as a non-zip file',
      'urn:air:other:other:huggingface:datasets/org/repo@main/model.safetensors',
    ],
    ['from a model repo', 'urn:air:other:other:huggingface:org/repo@main/x.zip'],
    ['with a query after .zip', 'urn:air:other:other:huggingface:datasets/org/repo@main/x?.zip'],
  ])('refuses a Hugging Face file named %s', async (_, sourceUrl) => {
    await expect(check({ sourceUrl })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('leaves prompts, timecodes, links, image URLs and orchestrator outputs alone', async () => {
    await expect(
      check({
        prompt: 'a poster in the huggingface style',
        mood: 'mood:calm',
        start: '00:00:05:00',
        contact: 'mailto:a@b.com',
        image: 'https://orchestration.civitai.com/v2/consumer/blobs/abc@2x.png',
        reference: 'http://example.com/ref@1.jpg',
        lora: 'urn:air:sdxl:lora:orchestrator:job-1@file.safetensors',
        model: civitai(10),
      })
    ).resolves.toEqual({ capOutput: false });
  });

  describe('the generation access rule', () => {
    it.each([
      ['a Private version', 20],
      ['a Draft version', 21],
      ['a Training version', 22],
      ['an InternalGeneration version', 23],
      ['an UnpublishedViolation version', 24],
      ['a Scheduled version', 25],
      ['an Unpublished version', 26],
    ])('refuses %s to a viewer who does not own it', async (_, id) => {
      await expect(check({ model: civitai(id) })).rejects.toThrow(
        `model version ${id} is not available for generation`
      );
    });

    it('refuses a restricted version named alongside a usable one', async () => {
      await expect(check({ model: civitai(10), lora: civitai(20) })).rejects.toThrow(
        'model version 20 is not available for generation'
      );
    });

    it.each([
      'https:civitai:1@20',
      'http:checkpoint:civitai:1@20',
      'sdxl://lora:civitai:1@20',
      'urn://air:civitai:1@20',
    ])('refuses a restricted version named by the URL-shaped AIR %s', async (model) => {
      await expect(check({ model })).rejects.toThrow(
        'model version 20 is not available for generation'
      );
    });

    it('refuses a restricted version named as a LoRA map key', async () => {
      await expect(check({ loras: { [civitai(20)]: 0.8 } })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('refuses an InternalGeneration version to its owner', async () => {
      await expect(check({ model: civitai(23) }, OWNER)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it.each([
      ['a Private', 20],
      ['a Scheduled', 25],
    ])('allows %s version to its owner', async (_, id) => {
      await expect(check({ model: civitai(id) }, OWNER)).resolves.toEqual({ capOutput: false });
    });

    // Deliberate (see checkAppStepResources): do not add a moderator exemption back.
    it.each([
      ['a Private version', 20],
      ['a Draft version', 21],
    ])("refuses a moderator running an app that names someone else's %s", async (_, id) => {
      await expect(check({ model: civitai(id) }, MODERATOR)).rejects.toThrow(
        `model version ${id} is not available for generation`
      );
    });

    it('allows a public version', async () => {
      await expect(check({ model: civitai(10) })).resolves.toEqual({ capOutput: false });
    });

    // Deliberate (see checkAppStepResources): do not widen this check to the full canGenerate rule.
    it('allows a training step naming a public base checkpoint', async () => {
      dbMock.dbRead.modelVersion.findMany.mockResolvedValue([
        { id: 10, baseModel: 'SDXL 1.0', ...published, covered: false },
      ] as never);
      await expect(
        check({
          engine: 'ai-toolkit',
          model: 'urn:air:sdxl:checkpoint:civitai:101055@10',
          trainingData: 'https://orchestration.civitai.com/v2/consumer/blobs/data.zip',
        })
      ).resolves.toEqual({ capOutput: false });
    });
  });
});

describe('stored files and blob keys off media inputs', () => {
  const STORED = 'a stored file URL is accepted only at a media input';
  const BLOB_KEY = 'a blob key is accepted only at a media input';
  const KEY = 'aaaaaaaaaa0123456789abcdef';

  it.each([
    ['on an object store host', { model: 'https://acct.r2.cloudflarestorage.com/b/abc' }],
    ['on a Spaces host', { model: 'https://bucket.nyc3.digitaloceanspaces.com/x' }],
    ['on the image host', { checkpoint: 'https://image.civitai.com/x/y' }],
    ['as a blob path on another host', { model: 'https://example.com/v2/consumer/blobs/abc' }],
    ['as an encoded blob path', { model: 'https://example.com/v2/consumer%2Fblobs/abc' }],
    [
      'in a comfy node outside the media keys',
      { workflow: { '4': { inputs: { ckpt_url: 'https://image.civitai.com/x' } } } },
    ],
    [
      'placed by $arguments at a model key',
      {
        steps: [{ $type: 'x', input: { model: { $ref: '$arguments', path: 'm' } } }],
        arguments: { m: 'https://acct.r2.cloudflarestorage.com/b/abc' },
      },
    ],
    [
      'as the default beside a reference',
      { model: { $ref: 'a', path: 'b', default: 'https://image.civitai.com/x' } },
    ],
  ])('refuses a stored file URL %s', async (_, input) => {
    await expect(checkAny(input)).rejects.toThrow(STORED);
  });

  it.each([
    ['at a media key', { image: 'https://image.civitai.com/x' }],
    ['under a media key', { images: [{ url: 'https://acct.r2.cloudflarestorage.com/b/abc' }] }],
    ['under trainingData', { trainingData: { blob: 'https://example.com/v2/consumer/blobs/abc' } }],
    ['in free text', { messages: [{ content: 'https://image.civitai.com/x' }] }],
    ['on another host', { model: 'https://example.com/a/b' }],
    [
      'placed by $arguments at a media key',
      {
        steps: [{ $type: 'x', input: { image: { $ref: '$arguments', path: 'm' } } }],
        arguments: { m: 'https://image.civitai.com/x' },
      },
    ],
    [
      'held in arguments that nothing places',
      {
        steps: [{ $type: 'x', input: { prompt: 'p' } }],
        arguments: { m: 'https://image.civitai.com/x' },
      },
    ],
  ])('accepts a URL %s', async (_, input) => {
    await expect(checkAny(input)).resolves.toEqual({ capOutput: false });
  });

  it.each([
    ['a blob key', { subjectMaskBlobKey: KEY }],
    ['a blob key with an extension', { subjectMaskBlobKey: `${KEY}.png` }],
    ['a training blob key', { trainingBlobKey: '0123456789abcdef0123456789abcdef' }],
    [
      'a blob key placed by $arguments',
      {
        steps: [{ $type: 'x', input: { subjectMaskBlobKey: { $ref: '$arguments', path: 'k' } } }],
        arguments: { k: KEY },
      },
    ],
  ])('refuses %s at a *BlobKey field off media', async (_, input) => {
    await expect(checkAny(input)).rejects.toThrow(BLOB_KEY);
  });

  it.each([
    ['at a media key', { blobKey: KEY }],
    ['that is too short', { subjectMaskBlobKey: KEY.slice(1) }],
    ['at another field', { garmentDescription: KEY }],
  ])('accepts a blob-key-shaped value %s', async (_, input) => {
    await expect(checkAny(input)).resolves.toEqual({ capOutput: false });
  });
  it.each([
    ['beside a default', { $ref: '$arguments', path: 'a', default: '' }],
    ['with a format', { $ref: '$arguments', path: 'a', format: 'x' }],
    ['with its keys in another case', { $REF: '$Arguments', Path: 'a' }],
    ['with a path this check cannot read', { $ref: '$arguments', path: ['a'] }],
  ])('judges an $arguments reference %s where it lands', async (_, ref) => {
    await expect(
      checkAny({
        steps: [{ $type: 'x', input: { prompt: ref } }],
        arguments: { a: 'https://image.civitai.com/x/y.png' },
      })
    ).rejects.toThrow(STORED);
  });

  it.each([['messages'], ['tools'], ['image']])(
    'reads a comfy node id %s as no field',
    async (nodeId) => {
      const graph = (inputs: Record<string, unknown>) => ({
        resources: [],
        trace: 'binary',
        workflow: { [nodeId]: { class_type: 'X', inputs } },
      });
      await expect(
        checkAny(graph({ model_url: 'https://foo.r2.cloudflarestorage.com/b/w' }))
      ).rejects.toThrow(STORED);
      await expect(checkAny(graph({ modelBlobKey: KEY }))).rejects.toThrow(BLOB_KEY);
      await expect(
        checkAny(graph({ image: 'https://foo.r2.cloudflarestorage.com/b/w' }))
      ).resolves.toEqual({ capOutput: false });
    }
  );

  it.each([
    ['an unversioned blob path', 'https://example.com/consumer/blobs/abc'],
    ['a doubled slash in the path', 'https://example.com/v1//consumer/blobs/abc'],
    ['trailing dots on the host', 'https://image.civitai.com../a'],
    ['a leading control', '\u0001https://image.civitai.com/a'],
    ['no scheme', '//image.civitai.com/a'],
  ])('refuses a stored file URL with %s', async (_, model) => {
    await expect(checkAny({ model })).rejects.toThrow(STORED);
  });
  it.each([
    ['a reference to another step', { $ref: 'x', ckpt_name: 'https://image.civitai.com/a/b' }],
    ['a recased reference', { $REF: 'x', path: 'p', url: 'https://image.civitai.com/a/b' }],
  ])('walks the other fields of %s', async (_, value) => {
    await expect(checkAny({ model: value })).rejects.toThrow(STORED);
  });

  it('accepts a stored file at a graph media input and refuses one at its weights input', async () => {
    const graph = (inputs: Record<string, unknown>) => ({
      resources: [],
      trace: 'binary',
      workflow: { '1': { class_type: 'LoadAudio', inputs } },
    });
    await expect(checkAny(graph({ audio: 'https://image.civitai.com/a' }))).resolves.toEqual({
      capOutput: false,
    });
    await expect(checkAny(graph({ model_file: 'https://image.civitai.com/a' }))).rejects.toThrow(
      STORED
    );
  });

  it('reads an input field named arguments as a field outside a workflow', async () => {
    await expect(
      check({ steps: 20, arguments: { m: 'https://image.civitai.com/x' } })
    ).rejects.toThrow(STORED);
  });
  it.each([
    ['an index', 'mask[0]'],
    ['a dotted index', 'mask.0'],
    ['every item', 'mask[*]'],
  ])('judges an $arguments path with %s where it lands', async (_, path) => {
    const body = (key: string) => ({
      steps: [{ $type: 'x', input: { [key]: { $ref: '$arguments', path } } }],
      arguments: { mask: ['https://image.civitai.com/consumer/blobs/K'] },
    });
    await expect(checkWorkflow(body('model'))).rejects.toThrow(STORED);
    await expect(checkWorkflow(body('image'))).resolves.toEqual({ capOutput: false });
  });

  it('judges every argument flat at the key an unresolvable reference lands on', async () => {
    await expect(
      checkWorkflow({
        steps: [{ $type: 'x', input: { model: { $ref: '$arguments', path: 'mask' } } }],
        arguments: { mask: 'https://image.civitai.com/x', MASK: 'y' },
      })
    ).rejects.toThrow(STORED);
  });

  it('judges a format with the argument written into it', async () => {
    await expect(
      checkWorkflow({
        steps: [
          {
            $type: 'x',
            input: {
              model: { $ref: '$arguments', path: 'h', format: 'https://image.civitai.{0}/x' },
            },
          },
        ],
        arguments: { h: 'com' },
      })
    ).rejects.toThrow(STORED);
    await expect(
      checkWorkflow({
        steps: [
          {
            $type: 'x',
            input: { prompt: { $ref: '$arguments', path: 's', format: 'a photo of {0}' } },
          },
        ],
        arguments: { s: 'a cat' },
      })
    ).resolves.toEqual({ capOutput: false });
  });

  it.each([
    ['a tab in the scheme', 'ht\ttps://image.civitai.com/consumer/blobs/K'],
    ['a bidi mark before it', '\u200ehttps://image.civitai.com/a'],
    ['no slashes', 'https:image.civitai.com/a'],
    ['one slash', 'HTTPS:/image.civitai.com/a'],
    ['a first-label host', 'https://blobs-b2.example.com/a'],
    ['a Backblaze host', 'https://s3.us-west-004.backblazeb2.com/b/a'],
    ['a bare suffix host', 'https://r2.cloudflarestorage.com/a'],
    ['an undecodable path', 'https://example.com/%E0%A4%A'],
  ])('refuses a stored file URL written with %s', async (_, model) => {
    await expect(check({ model })).rejects.toThrow(STORED);
  });

  it.each([
    ['protocol-relative', '//image.civitai.com/consumer/blobs/K'],
    ['behind a control', '\u0001https://image.civitai.com/consumer/blobs/K'],
  ])('refuses a %s stored file URL as a map key', async (_, key) => {
    await expect(check({ loras: { [key]: 1 } })).rejects.toThrow(STORED);
  });

  it('holds a graph input named like free text to the rule', async () => {
    await expect(
      check({
        resources: [],
        trace: 'binary',
        workflow: { '1': { class_type: 'X', inputs: { messages: 'https://image.civitai.com/a' } } },
      })
    ).rejects.toThrow(STORED);
  });

  it('accepts a repeat over stored images placed at a media input', async () => {
    await expect(
      checkWorkflow({
        steps: [
          {
            $type: 'repeat',
            name: 'r',
            input: {
              for: { $ref: '$arguments', path: 'items', as: 'item' },
              template: { $type: 'imageGen', input: { image: { $ref: 'item', path: 'src' } } },
            },
          },
        ],
        arguments: { items: [{ src: 'https://image.civitai.com/x/y.png' }] },
      })
    ).resolves.toEqual({ capOutput: false });
  });
  it('accepts an absent optional argument beside a stored image', async () => {
    await expect(
      checkWorkflow({
        steps: [
          {
            $type: 'imageGen',
            input: {
              image: { $ref: '$arguments', path: 'image' },
              seed: { $ref: '$arguments', path: 'seed', default: 1 },
              extra: { $ref: '$arguments', path: 'imgs[5]', default: '' },
            },
          },
        ],
        arguments: { image: 'https://image.civitai.com/x/y.png', imgs: [] },
      })
    ).resolves.toEqual({ capOutput: false });
  });

  const repeat = (type: string, input: Record<string, unknown>, items: unknown[]) => ({
    steps: [
      {
        $type: type,
        name: 'r',
        input: {
          for: { $ref: '$arguments', path: 'items', as: 'it' },
          template: { $type: 'textToImage', input },
        },
      },
    ],
    arguments: { items },
  });

  it.each([
    ['repeat', { model: { $ref: 'it' } }, ['https://foo.r2.cloudflarestorage.com/b/w'], STORED],
    [
      'Repeat',
      { model: { $ref: 'it', path: 'src' } },
      [{ src: 'https://image.civitai.com/a' }],
      STORED,
    ],
    ['repeat', { modelBlobKey: { $ref: 'it' } }, [KEY], BLOB_KEY],
  ])(
    'judges what a %s loop variable places where it lands',
    async (type, input, items, message) => {
      await expect(checkWorkflow(repeat(type, input, items))).rejects.toThrow(message);
    }
  );

  it('holds a repeat-shaped object outside a workflow to the rule', async () => {
    await expect(
      check({
        model: {
          $type: 'repeat',
          input: { for: { $ref: 'x', path: 'https://image.civitai.com/a', as: 'y' } },
        },
      })
    ).rejects.toThrow(STORED);
  });

  it('writes the argument into every placeholder form of a format', async () => {
    await expect(
      checkWorkflow({
        steps: [
          {
            $type: 'x',
            input: {
              ckpt: { $ref: '$arguments', path: 'h', format: 'https://image.civitai.{0,-1}/x' },
            },
          },
        ],
        arguments: { h: 'com' },
      })
    ).rejects.toThrow(STORED);
  });

  it('reads graph media names only inside a graph node', async () => {
    await expect(
      check({
        model: { class_type: 'X', inputs: {}, latent: 'https://foo.r2.cloudflarestorage.com/b/w' },
      })
    ).rejects.toThrow(STORED);
  });
  it.each([
    ['a key with brackets', 'a[0]', { 'a[0]': 'https://foo.r2.cloudflarestorage.com/b/w', a: [] }],
    ['an empty segment', 'a..b', { a: { '': { b: 'https://foo.r2.cloudflarestorage.com/b/w' } } }],
    ['a leading dot', '.b', { '': { b: 'https://foo.r2.cloudflarestorage.com/b/w' } }],
  ])('judges an $arguments path read as the orchestrator reads %s', async (_, path, args) => {
    await expect(
      checkWorkflow({
        steps: [{ $type: 'textToImage', input: { model: { $ref: '$arguments', path } } }],
        arguments: args,
      })
    ).rejects.toThrow(STORED);
  });

  const loopBody = (
    path: string,
    input: Record<string, unknown>,
    args: Record<string, unknown>
  ) => ({
    steps: [
      {
        $type: 'repeat',
        name: 'r',
        input: {
          for: { $ref: '$arguments', path, as: 'it' },
          template: { $type: 'textToImage', input },
        },
      },
    ],
    arguments: args,
  });

  it.each([
    [
      'a key with a bracket',
      'a[',
      { model: { $ref: 'it' } },
      { 'a[': ['https://foo.r2.cloudflarestorage.com/b/w'], a: [] },
    ],
    [
      'a clause it cannot read',
      "['a']",
      { model: { $ref: 'it', path: 'src' } },
      { a: [{ src: 'https://image.civitai.com/a' }] },
    ],
  ])('judges loop items reached through %s', async (_, path, input, args) => {
    await expect(checkWorkflow(loopBody(path, input, args))).rejects.toThrow(STORED);
  });

  it('places both loops through a reused loop name', async () => {
    const inner = {
      $type: 'repeat',
      input: {
        for: { $ref: '$arguments', path: 'inner', as: 'it' },
        template: { $type: 'textToImage', input: { model: { $ref: 'it' } } },
      },
    };
    await expect(
      checkWorkflow({
        steps: [
          {
            $type: 'repeat',
            name: 'r',
            input: { for: { $ref: '$arguments', path: 'outer', as: 'it' }, template: inner },
          },
        ],
        arguments: { outer: ['https://foo.r2.cloudflarestorage.com/b/w'], inner: ['a'] },
      })
    ).rejects.toThrow(STORED);
  });

  it('holds a graph node field outside its inputs to the rule', async () => {
    await expect(
      check({
        resources: [],
        trace: 'binary',
        workflow: {
          '1': {
            class_type: 'X',
            inputs: {},
            messages: 'https://foo.r2.cloudflarestorage.com/b/w',
          },
        },
      })
    ).rejects.toThrow(STORED);
  });
  it('judges a loop item path with spaces where it lands', async () => {
    await expect(
      checkWorkflow(
        loopBody(
          'items',
          { model: { $ref: 'it', path: 's rc' } },
          { items: [{ 's rc': 'https://foo.r2.cloudflarestorage.com/b/w' }] }
        )
      )
    ).rejects.toThrow(STORED);
  });

  it('judges a format with an argument read through a path with spaces', async () => {
    await expect(
      checkWorkflow({
        steps: [
          {
            $type: 'textToImage',
            input: { model: { $ref: '$arguments', path: 'h ost', format: 'https://{0}' } },
          },
        ],
        arguments: { 'h ost': 'image.civitai.com/x' },
      })
    ).rejects.toThrow(STORED);
  });

  it('judges a format against every leaf an unreadable loop clause places', async () => {
    await expect(
      checkWorkflow(
        loopBody(
          'nope',
          { model: { $ref: 'it', path: '', format: 'https://{0}' } },
          { a: ['image.civitai.com/x'] }
        )
      )
    ).rejects.toThrow(STORED);
  });

  it('accepts paths with spaces that place a stored image at a media input', async () => {
    await expect(
      checkWorkflow({
        steps: [
          {
            $type: 'textToImage',
            input: {
              image: { $ref: '$arguments', path: 'my img' },
              prompt: { $ref: '$arguments', path: 'p q' },
            },
          },
        ],
        arguments: { 'my img': 'https://image.civitai.com/a/b.png', 'p q': 'hello' },
      })
    ).resolves.toEqual({ capOutput: false });
  });
  it.each([
    ['a number', 'https://blobs-b{0}.example.com/w', { n: 2 }],
    ['null', 'https://blobs-b2{0}.example.com/w', { n: null }],
    ['nothing', 'https://blobs-b2{0}.example.com/w', {}],
  ])('judges a format filled with %s', async (_, format, args) => {
    await expect(
      checkWorkflow({
        steps: [
          { $type: 'textToImage', input: { model: { $ref: '$arguments', path: 'n', format } } },
        ],
        arguments: args,
      })
    ).rejects.toThrow(STORED);
  });

  it('judges a format filled with its default', async () => {
    await expect(
      checkWorkflow({
        steps: [
          {
            $type: 'textToImage',
            input: {
              model: {
                $ref: '$arguments',
                path: 'n',
                format: 'https://{0}/w',
                default: 'blobs-b2.example.com',
              },
            },
          },
        ],
        arguments: {},
      })
    ).rejects.toThrow(STORED);
  });

  it('refuses a format it would take too long to fill', async () => {
    await expect(
      checkWorkflow({
        steps: [
          {
            $type: 'textToImage',
            input: {
              model: {
                $ref: '$arguments',
                path: 'xs',
                format: `https://example.com/${'a'.repeat(60_000)}{0}`,
              },
            },
          },
        ],
        arguments: { xs: Array(20_000).fill('') },
      })
    ).rejects.toThrow('too large to check');
  });

  it.each([["['a']"], ['..a'], ['$.a']])(
    'places every argument for the JSONPath form %s',
    async (path) => {
      await expect(
        checkWorkflow({
          steps: [{ $type: 'textToImage', input: { model: { $ref: '$arguments', path } } }],
          arguments: { a: 'https://image.civitai.com/x' },
        })
      ).rejects.toThrow(STORED);
    }
  );
  it.each([['url'], ['blob'], ['sourceUrl']])(
    'holds a graph input named %s to the rule',
    async (input) => {
      await expect(
        check({
          resources: [],
          trace: 'binary',
          workflow: {
            '1': {
              class_type: 'X',
              inputs: { [input]: 'https://foo.r2.cloudflarestorage.com/b/w' },
            },
          },
        })
      ).rejects.toThrow(STORED);
    }
  );
  it('accepts a stored image at a graph loader image input', async () => {
    await expect(
      check({
        resources: [],
        trace: 'binary',
        workflow: {
          '1': { class_type: 'LoadImage', inputs: { image: 'https://image.civitai.com/a.png' } },
        },
      })
    ).resolves.toEqual({ capOutput: false });
  });

  it('refuses a blob key at a *BlobId field off media', async () => {
    await expect(check({ entries: [{ blobId: KEY }] })).rejects.toThrow(BLOB_KEY);
  });
});
