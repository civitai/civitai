import { describe, expect, it } from 'vitest';
import {
  collectBlockStepTypes,
  isRepeatStepType,
  resolveBlockWorkflowGraph,
  WORKFLOW_INPUT_DEPTH_MAX,
  WORKFLOW_MAX_REFS,
  WORKFLOW_MAX_STEPS,
  WORKFLOW_RESERVED_STEP_NAME,
} from '~/server/services/blocks/workflow-graph';
import type { BlockWorkflowStepInput } from '~/server/services/blocks/workflow-graph';
import { BLOCK_STEP_NAME } from '~/server/services/blocks/workflow.service';

/**
 * The `kind:'workflow'` step graph: step names and the reference rules. Every
 * refusal is asserted on its own `errorCode` AND its own message, so a rule that
 * stopped firing cannot hide behind a neighbouring one.
 */

const step = (over: Partial<BlockWorkflowStepInput> = {}): BlockWorkflowStepInput => ({
  $type: 'imageGen',
  input: { prompt: 'a cat' },
  ...over,
});
const ref = ($ref: string, path = 'output.images[0].url') => ({ $ref, path });

function refusal(steps: BlockWorkflowStepInput[]) {
  const result = resolveBlockWorkflowGraph({ steps });
  if (result.ok) throw new Error('expected a refusal, got a resolved graph');
  return result;
}
function resolved(steps: BlockWorkflowStepInput[]) {
  const result = resolveBlockWorkflowGraph({ steps });
  if (!result.ok) throw new Error(`expected a resolved graph, got: ${result.error}`);
  return result.steps;
}

describe('resolveBlockWorkflowGraph — names', () => {
  it('names an unnamed step by its position and keeps a chosen name', () => {
    const steps = resolved([step(), step({ name: 'upscale' }), step()]);
    expect(steps.map((s) => s.name)).toEqual(['$0', 'upscale', '$2']);
  });

  it("accepts a step's OWN positional name and refuses another step's", () => {
    expect(resolved([step({ name: '$0' })])[0].name).toBe('$0');
    const r = refusal([step(), step({ name: '$0' })]);
    expect(r.errorCode).toBe('workflow_ref_invalid');
    expect(r.error).toContain('workflow step 1: name "$0" must match');
  });

  it.each(['Upscale', '1st', 'a.b', 'a b', '$arguments', 'x'.repeat(33), '-a'])(
    'refuses the name %j',
    (name) => {
      const r = refusal([step({ name })]);
      expect(r.errorCode).toBe('workflow_ref_invalid');
      expect(r.error).toContain('workflow step 0: name ');
      expect(r.error).toContain('must match');
    }
  );

  it('accepts a 32-character name (the boundary the 33-character one is over)', () => {
    expect(resolved([step({ name: 'x'.repeat(32) })])[0].name).toBe('x'.repeat(32));
  });

  it('refuses a duplicate name, naming the SECOND step', () => {
    const r = refusal([step({ name: 'a' }), step({ name: 'b' }), step({ name: 'a' })]);
    expect(r.errorCode).toBe('workflow_ref_invalid');
    expect(r.error).toBe('workflow step 2: name "a" is used twice');
  });

  it('reserves the single-step arms’ step name', () => {
    // The literal in the import-free module must equal the constant it stands for.
    expect(WORKFLOW_RESERVED_STEP_NAME).toBe(BLOCK_STEP_NAME);
    const r = refusal([step({ name: BLOCK_STEP_NAME })]);
    expect(r.errorCode).toBe('workflow_ref_invalid');
    expect(r.error).toBe(`workflow step 0: name "${BLOCK_STEP_NAME}" is reserved`);
  });
});

describe('resolveBlockWorkflowGraph — step count', () => {
  it(`accepts ${WORKFLOW_MAX_STEPS} steps and refuses ${WORKFLOW_MAX_STEPS + 1}`, () => {
    expect(WORKFLOW_MAX_STEPS).toBe(8);
    expect(resolved(Array.from({ length: 8 }, () => step()))).toHaveLength(8);
    const r = refusal(Array.from({ length: 9 }, () => step()));
    expect(r.errorCode).toBe('workflow_too_many_steps');
    expect(r.error).toBe('a workflow may have at most 8 steps (got 9)');
  });
});

describe('resolveBlockWorkflowGraph — references', () => {
  it('accepts a reference to an EARLIER step, by name and by position', () => {
    const steps = resolved([
      step({ name: 'gen' }),
      step({ $type: 'imageUpscaler', input: { image: ref('gen') } }),
      step({ $type: 'convertImage', input: { image: ref('$1'), nested: [{ deep: ref('gen') }] } }),
    ]);
    expect(steps).toHaveLength(3);
  });

  it('accepts a reference to `$arguments`, with `default` and `format`', () => {
    expect(
      resolved([
        step({
          input: { prompt: { $ref: '$arguments', path: 'p', default: 'x', format: 'a {0}' } },
        }),
      ])
    ).toHaveLength(1);
  });

  it('🔴 refuses a reference to a LATER step (the order rule)', () => {
    const r = refusal([step({ input: { image: ref('later') } }), step({ name: 'later' })]);
    expect(r.errorCode).toBe('workflow_ref_invalid');
    expect(r.error).toBe(
      'workflow step 0: "$ref": "later" does not name "$arguments" or an earlier step'
    );
  });

  it('refuses a SELF reference', () => {
    const r = refusal([step({ name: 'me', input: { image: ref('me') } })]);
    expect(r.errorCode).toBe('workflow_ref_invalid');
    expect(r.error).toContain('workflow step 0: "$ref": "me" does not name');
  });

  it('refuses a reference to a step that does not exist, naming the step index', () => {
    const r = refusal([step(), step(), step({ input: { a: { b: [ref('nope')] } } })]);
    expect(r.errorCode).toBe('workflow_ref_invalid');
    expect(r.error).toContain('workflow step 2: "$ref": "nope" does not name');
  });

  it('refuses a positional reference to a step that was given a name', () => {
    // A reference names a step by the name it actually carries.
    const r = refusal([step({ name: 'gen' }), step({ input: { image: ref('$0') } })]);
    expect(r.error).toContain('workflow step 1: "$ref": "$0" does not name');
  });

  it('checks a reference that IS the whole input', () => {
    const r = refusal([step({ input: ref('ghost') as unknown as Record<string, unknown> })]);
    expect(r.error).toContain('workflow step 0: "$ref": "ghost" does not name');
  });

  it('refuses a reference whose `$ref` or `path` is not a string', () => {
    for (const bad of [
      { $ref: 3, path: 'p' },
      { $ref: '$arguments', path: 4 },
    ]) {
      const r = refusal([step({ input: { v: bad } })]);
      expect(r.errorCode).toBe('workflow_ref_invalid');
      expect(r.error).toBe(
        'workflow step 0: a reference needs a string "$ref" and a string "path"'
      );
    }
  });

  it('refuses a non-string `format`', () => {
    const r = refusal([step({ input: { v: { $ref: '$arguments', path: 'p', format: 7 } } })]);
    expect(r.error).toBe('workflow step 0: a reference "format" must be a string');
  });

  it('does NOT treat an object with other keys as a reference', () => {
    // The orchestrator's own predicate: `$ref` + `path` and nothing but
    // `default` / `format`. A JSON-schema `$ref`, or an object with an extra key,
    // is plain data and is forwarded whatever it names.
    const steps = resolved([
      step({
        input: {
          schema: { $ref: '#/definitions/thing' },
          notARef: { $ref: 'nowhere', path: 'p', extra: true },
        },
      }),
    ]);
    expect(steps).toHaveLength(1);
  });

  it(`accepts ${WORKFLOW_MAX_REFS} references and refuses one more`, () => {
    const refs = (n: number) => Array.from({ length: n }, () => ref('$arguments', 'x'));
    expect(WORKFLOW_MAX_REFS).toBe(64);
    expect(
      resolved([step({ input: { a: refs(40) } }), step({ input: { a: refs(24) } })])
    ).toHaveLength(2);
    const r = refusal([step({ input: { a: refs(40) } }), step({ input: { a: refs(25) } })]);
    expect(r.errorCode).toBe('workflow_ref_invalid');
    expect(r.error).toBe('workflow step 1: a workflow may hold at most 64 references');
  });

  it(`refuses an input nested deeper than ${WORKFLOW_INPUT_DEPTH_MAX} levels`, () => {
    const nest = (levels: number) => {
      let value: unknown = 'leaf';
      for (let i = 0; i < levels; i += 1) value = { v: value };
      return value as Record<string, unknown>;
    };
    expect(WORKFLOW_INPUT_DEPTH_MAX).toBe(32);
    // `nest(n)` puts its innermost object at depth n - 1.
    expect(resolved([step({ input: nest(33) })])).toHaveLength(1);
    const r = refusal([step({ input: nest(34) })]);
    expect(r.errorCode).toBe('workflow_ref_invalid');
    expect(r.error).toBe('workflow step 0: input is nested deeper than 32 levels');
  });

  it('forwards each `input` as the SAME object it was given', () => {
    const input = { prompt: 'a cat', image: ref('$arguments', 'img') };
    expect(resolved([step({ input })])[0].input).toBe(input);
  });

  it('records `suppressOutput` only when it is true', () => {
    const steps = resolved([
      step({ suppressOutput: true }),
      step({ suppressOutput: false }),
      step(),
    ]);
    expect(steps.map((s) => s.suppressOutput)).toEqual([true, false, false]);
  });
});

describe('resolveBlockWorkflowGraph — repeat', () => {
  const repeat = (forRef: string, template: Record<string, unknown>, as = 'item') =>
    step({
      $type: 'repeat',
      name: 'loop',
      input: { for: { $ref: forRef, path: 'output.frames', as }, template },
    });

  it('lets the template reference the loop variable, an earlier step and `$arguments`', () => {
    const steps = resolved([
      step({ name: 'frames', $type: 'videoFrameExtraction' }),
      repeat('frames', {
        $type: 'wdTagging',
        input: { mediaUrl: ref('item', 'url'), other: ref('frames'), arg: ref('$arguments', 'x') },
      }),
    ]);
    expect(steps[1].stepTypes).toEqual(['repeat', 'wdTagging']);
  });

  it('refuses a `for` clause that iterates a LATER step', () => {
    const r = refusal([
      repeat('frames', { $type: 'wdTagging', input: {} }),
      step({ name: 'frames' }),
    ]);
    expect(r.errorCode).toBe('workflow_ref_invalid');
    expect(r.error).toContain('workflow step 0: "$ref": "frames" does not name');
  });

  it('does not let the loop variable leak outside the template', () => {
    const r = refusal([
      step({ name: 'frames' }),
      repeat('frames', { $type: 'wdTagging', input: {} }),
      step({ input: { v: ref('item', 'url') } }),
    ]);
    expect(r.error).toContain('workflow step 2: "$ref": "item" does not name');
  });

  it('refuses a template reference to an unknown source', () => {
    const r = refusal([
      step({ name: 'frames' }),
      repeat('frames', { $type: 'wdTagging', input: { mediaUrl: ref('elsewhere') } }),
    ]);
    expect(r.error).toContain('workflow step 1: "$ref": "elsewhere" does not name');
  });
});

describe('collectBlockStepTypes', () => {
  const FOR = { $ref: '$arguments', path: 'items', as: 'item' };
  const SHAPE_ERROR =
    'a repeat step needs exactly { for, template } with a template "$type", nested at most 4 deep';
  /** `depth` repeats wrapped around one `leaf` step. */
  const nested = (depth: number, leaf = 'mediaHash') => {
    let input: Record<string, unknown> = { for: FOR, template: { $type: leaf, input: {} } };
    for (let i = 1; i < depth; i += 1) input = { for: FOR, template: { $type: 'repeat', input } };
    return input;
  };

  it('returns only the step’s own type for an ordinary step', () => {
    expect(collectBlockStepTypes('imageGen', { template: { $type: 'x' } })).toEqual(['imageGen']);
  });

  it('follows a `repeat` template, however `repeat` is cased', () => {
    expect(isRepeatStepType('Repeat')).toBe(true);
    expect(collectBlockStepTypes('REPEAT', nested(1, 'wdTagging'))).toEqual([
      'REPEAT',
      'wdTagging',
    ]);
  });

  it('follows repeats nested up to the bound, and no further', () => {
    expect(collectBlockStepTypes('repeat', nested(4))).toEqual([
      'repeat',
      'repeat',
      'repeat',
      'repeat',
      'mediaHash',
    ]);
    expect(collectBlockStepTypes('repeat', nested(5))).toBeNull();
    expect(
      resolveBlockWorkflowGraph({ steps: [{ $type: 'repeat', input: nested(4, 'echo') }] }).ok
    ).toBe(true);
    const r = resolveBlockWorkflowGraph({ steps: [{ $type: 'repeat', input: nested(5, 'echo') }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(`workflow step 0: ${SHAPE_ERROR}`);
  });

  it.each([
    ['a re-cased `template` key', { for: FOR, Template: { $type: 'mediaHash', input: {} } }],
    [
      'both spellings of `template`',
      { for: FOR, template: { $type: 'echo' }, TEMPLATE: { $type: 'mediaHash' } },
    ],
    [
      'a re-cased `$type` in the template',
      { for: FOR, template: { $type: 'echo', $Type: 'mediaHash' } },
    ],
    ['a re-cased `input` in the template', { for: FOR, template: { $type: 'echo', Input: {} } }],
    ['a re-cased `for` key', { For: FOR, template: { $type: 'echo', input: {} } }],
    [
      'a re-cased `$ref` in the for clause',
      { for: { $Ref: 'x', path: 'p', as: 'i' }, template: { $type: 'echo' } },
    ],
    ['no template', { for: FOR }],
    ['no for clause', { template: { $type: 'echo', input: {} } }],
    ['a template that is not an object', { for: FOR, template: 'echo' }],
    ['a template `$type` that is not a string', { for: FOR, template: { $type: 7, input: {} } }],
    ['an unknown key', { for: FOR, template: { $type: 'echo', input: {} }, extra: 1 }],
  ])('🔴 refuses a repeat with %s rather than checking it in part', (_label, input) => {
    expect(collectBlockStepTypes('repeat', input)).toBeNull();
    const r = resolveBlockWorkflowGraph({
      steps: [{ $type: 'repeat', input: input as Record<string, unknown> }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorCode).toBe('workflow_ref_invalid');
      expect(r.error).toBe(`workflow step 0: ${SHAPE_ERROR}`);
    }
  });
});
