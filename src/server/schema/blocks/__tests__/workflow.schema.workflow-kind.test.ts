import { describe, expect, it } from 'vitest';
import {
  blockMultiStepWorkflowBodySchema,
  blockWorkflowBodySchema,
  PASS_THROUGH_INPUT_BYTES_MAX,
  WORKFLOW_INPUT_BYTES_MAX,
} from '~/server/schema/blocks/workflow.schema';

/**
 * The `kind:'workflow'` WIRE shape. This schema checks shape and size only — the
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
    const input = (bytes: number) => ({ p: 'x'.repeat(bytes - 8) });
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
