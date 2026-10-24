import { describe, expect, it } from 'vitest';
import {
  blockMultiStepWorkflowBodySchema,
  blockWorkflowBodySchema,
  PASS_THROUGH_INPUT_BYTES_MAX,
  WORKFLOW_INPUT_BYTES_MAX,
} from '~/server/schema/blocks/workflow.schema';

/**
 * The `kind:'workflow'` WIRE shape. This schema checks shape, size and inline media only — the
 * step count, the name rules and the reference graph are refused later, with an
 * `errorCode`, by `resolveBlockWorkflowGraph` (`workflow-graph.test.ts`) and the
 * router (`blocks.router.workflowKind.test.ts`).
 */

const body = (over: Record<string, unknown> = {}) => ({
  kind: 'workflow',
  steps: [
    { name: 'gen', $type: 'imageGen', input: { prompt: 'a cat' } },
    {
      $type: 'imageUpscaler',
      input: { image: { $ref: 'gen', path: 'output.images[0].url' } },
      suppressOutput: false,
    },
  ],
  ...over,
});

describe("blockWorkflowBodySchema — kind:'workflow'", () => {
  it('parses a multi-step body through the OUTER union, unchanged', () => {
    const parsed = blockWorkflowBodySchema.parse(body({ arguments: { strength: 0.4 } }));
    expect(parsed).toEqual(body({ arguments: { strength: 0.4 } }));
  });

  it('parses a single step with no name, no arguments and no suppressOutput', () => {
    const one = { kind: 'workflow', steps: [{ $type: 'echo', input: {} }] };
    expect(blockWorkflowBodySchema.parse(one)).toEqual(one);
  });

  it('refuses an EMPTY step list', () => {
    const r = blockWorkflowBodySchema.safeParse(body({ steps: [] }));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(['steps']);
  });

  it('accepts MORE than the step cap — the cap is refused with an errorCode, not here', () => {
    // A schema rejection is thrown at the tRPC boundary, where it cannot carry
    // `workflow_too_many_steps`. See `resolveBlockWorkflowGraph`.
    const many = body({ steps: Array.from({ length: 9 }, () => ({ $type: 'echo', input: {} })) });
    expect(blockWorkflowBodySchema.safeParse(many).success).toBe(true);
  });

  it('has NO `maxBuzz`: the field is refused, at the body and at a step', () => {
    const atBody = blockWorkflowBodySchema.safeParse(body({ maxBuzz: 50 }));
    expect(atBody.success).toBe(false);
    if (!atBody.success) expect(JSON.stringify(atBody.error.issues)).toContain('maxBuzz');

    const atStep = blockWorkflowBodySchema.safeParse(
      body({ steps: [{ $type: 'echo', input: {}, maxBuzz: 50 }] })
    );
    expect(atStep.success).toBe(false);
    if (!atStep.success) expect(JSON.stringify(atStep.error.issues)).toContain('maxBuzz');
  });

  it.each(['priority', 'timeout', 'retries', 'metadata'])(
    'refuses the server-owned step field `%s`',
    (field) => {
      const r = blockWorkflowBodySchema.safeParse(
        body({ steps: [{ $type: 'echo', input: {}, [field]: 1 }] })
      );
      expect(r.success).toBe(false);
      if (!r.success) expect(JSON.stringify(r.error.issues)).toContain(field);
    }
  );

  it.each(['tags', 'callbacks', 'tips', 'metadata', 'externalId'])(
    'refuses the server-owned workflow field `%s`',
    (field) => {
      const r = blockWorkflowBodySchema.safeParse(body({ [field]: ['x'] }));
      expect(r.success).toBe(false);
      if (!r.success) expect(JSON.stringify(r.error.issues)).toContain(field);
    }
  );

  it('bounds `$type` like the pass-through arm (1..64 characters)', () => {
    const typed = ($type: string) => body({ steps: [{ $type, input: {} }] });
    expect(blockWorkflowBodySchema.safeParse(typed('x'.repeat(64))).success).toBe(true);
    for (const $type of ['', 'x'.repeat(65)]) {
      const r = blockWorkflowBodySchema.safeParse(typed($type));
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0].path).toEqual(['steps', 0, '$type']);
    }
  });

  it('requires `input` to be an object on every step', () => {
    const r = blockWorkflowBodySchema.safeParse(
      body({ steps: [{ $type: 'echo', input: {} }, { $type: 'echo' }] })
    );
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(['steps', 1, 'input']);
  });

  it('bounds the SUM of every step input plus arguments', () => {
    expect(WORKFLOW_INPUT_BYTES_MAX).toBe(PASS_THROUGH_INPUT_BYTES_MAX);
    // `{"p":"…"}` is 8 bytes of framing around the string.
    // `.` is outside the base64 alphabet: an all-letter pad is refused as inline media first.
    const input = (bytes: number) => ({ p: '.'.repeat(bytes - 8) });
    const half = WORKFLOW_INPUT_BYTES_MAX / 2;
    const fits = body({
      steps: [
        { $type: 'echo', input: input(half) },
        { $type: 'echo', input: input(half) },
      ],
    });
    expect(blockMultiStepWorkflowBodySchema.safeParse(fits).success).toBe(true);

    // Each step alone is under the bound; only the SUM is over it.
    const over = body({
      steps: [
        { $type: 'echo', input: input(half) },
        { $type: 'echo', input: input(half + 1) },
      ],
    });
    const r = blockMultiStepWorkflowBodySchema.safeParse(over);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toContain('byte limit');

    // `arguments` counts toward the same sum.
    const viaArguments = body({
      steps: [{ $type: 'echo', input: input(half) }],
      arguments: input(half + 1),
    });
    expect(blockMultiStepWorkflowBodySchema.safeParse(viaArguments).success).toBe(false);
  });

  it('leaves every other kind parsing exactly as before', () => {
    const passThrough = { kind: 'step', $type: 'imageGen', input: { a: 1 }, maxBuzz: 10 };
    expect(blockWorkflowBodySchema.parse(passThrough)).toEqual(passThrough);
    const registry = { kind: 'step', step: 'convert-image', params: {} };
    expect(blockWorkflowBodySchema.parse(registry)).toEqual(registry);
    // `steps` on a `kind:'step'` body is still refused: the new kind did not
    // widen the old one.
    expect(
      blockWorkflowBodySchema.safeParse({ ...passThrough, steps: [{ $type: 'echo', input: {} }] })
        .success
    ).toBe(false);
  });
});

describe("kind:'workflow' — inline media is refused", () => {
  const fix =
    'pass a hosted url instead — upload the image, video or audio with useMediaUpload ' +
    "(an image also works with useImageUpload({ purpose: 'generationSource' }) or useImagePicker) and pass the returned url";
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
  const issuesOf = (b: unknown) => {
    const parsed = blockWorkflowBodySchema.safeParse(b);
    return parsed.success ? [] : parsed.error.issues.map((i) => [i.path, i.message]);
  };

  it('in any step input, at its full path', () => {
    const withPhoto = body({
      steps: [
        { name: 'gen', $type: 'imageGen', input: { prompt: 'a cat' } },
        { $type: 'imageGen', input: { images: ['https://image.civitai.com/a.jpeg', tinyPng] } },
      ],
    });
    expect(issuesOf(withPhoto)).toEqual([
      [
        ['steps', 1, 'input', 'images', 1],
        `steps[1].input.images[1] carries inline media (data URI/base64); ${fix}`,
      ],
    ]);
  });

  it('in `arguments`, which a step input can $ref', () => {
    expect(issuesOf(body({ arguments: { photo: tinyPng } }))).toEqual([
      [['arguments', 'photo'], `arguments.photo carries inline media (data URI/base64); ${fix}`],
    ]);
  });

  it('spends one value budget across all steps, so many steps cannot each hide padding', () => {
    const pad = () =>
      Object.fromEntries(Array.from({ length: 100_000 }, (_, i) => [`k${i}`, undefined]));
    const steps = [
      { $type: 'imageGen', input: pad() },
      { $type: 'imageGen', input: pad() },
      { $type: 'imageGen', input: { ...pad(), photo: tinyPng } },
    ];
    expect(issuesOf(body({ steps }))).toEqual([
      [['steps'], 'step inputs and arguments hold more than 262144 values in total'],
    ]);
  });

  it('counts `arguments` against the same budget as the steps', () => {
    const pad = () =>
      Object.fromEntries(Array.from({ length: 150_000 }, (_, i) => [`k${i}`, undefined]));
    const withArguments = body({
      steps: [{ $type: 'imageGen', input: pad() }],
      arguments: { ...pad(), photo: tinyPng },
    });
    expect(issuesOf(withArguments)).toEqual([
      [['steps'], 'step inputs and arguments hold more than 262144 values in total'],
    ]);
  });

  it('still reports padding in a later field once an earlier one is over the byte cap', () => {
    const pad = Object.fromEntries(Array.from({ length: 300_000 }, (_, i) => [`k${i}`, undefined]));
    const over = body({
      steps: [
        { $type: 'imageGen', input: { text: '.'.repeat(WORKFLOW_INPUT_BYTES_MAX), next: 'a' } },
      ],
      arguments: pad,
    });
    expect(issuesOf(over)).toEqual([
      [['steps'], 'step inputs and arguments hold more than 262144 values in total'],
    ]);
  });

  it('leaves a photo in a later field to the byte cap once an earlier one is over it', () => {
    const over = body({
      steps: [{ $type: 'imageGen', input: { text: '.'.repeat(WORKFLOW_INPUT_BYTES_MAX) } }],
      arguments: { photo: tinyPng },
    });
    expect(issuesOf(over)).toEqual([
      [['steps'], 'workflow step inputs and arguments exceed the 262144-byte limit'],
    ]);
  });

  it('over the byte cap, reports ONLY the inline-media issue', () => {
    const photo = `data:image/jpeg;base64,${'/9j/4AAQSkZJRgABAQ'.repeat(20_000)}`;
    expect(photo.length).toBeGreaterThan(WORKFLOW_INPUT_BYTES_MAX);
    expect(issuesOf(body({ steps: [{ $type: 'imageGen', input: { ImageUrl: photo } }] }))).toEqual([
      [
        ['steps', 0, 'input', 'ImageUrl'],
        `steps[0].input.ImageUrl carries inline media (data URI/base64); ${fix}`,
      ],
    ]);
  });

  it('accepts hosted urls and long prose in step inputs and arguments', () => {
    const prose = 'a watercolor fox in a misty forest, '.repeat(300);
    const withUrls = body({
      steps: [
        { name: 'gen', $type: 'imageGen', input: { prompt: prose } },
        { $type: 'imageGen', input: { images: ['https://image.civitai.com/a.jpeg'] } },
      ],
      arguments: { source: 'https://image.civitai.com/b.jpeg', caption: prose },
    });
    expect(issuesOf(withUrls)).toEqual([]);
  });
});
