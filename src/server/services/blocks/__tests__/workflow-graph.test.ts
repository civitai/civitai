import { describe, expect, it } from 'vitest';
import {
  collectBlockStepTypes,
  isMergeStepType,
  isRepeatStepType,
  resolveBlockWorkflowGraph,
  WORKFLOW_INPUT_DEPTH_MAX,
  WORKFLOW_MAX_REFS,
  WORKFLOW_MAX_STEPS,
  WORKFLOW_REPEAT_MAX_ITERATIONS,
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
  const ARGS = { images: [{ url: 'a' }, { url: 'b' }, { url: 'c' }], strength: 0.4 };
  const repeat = (
    forClause: Record<string, unknown>,
    template: Record<string, unknown>,
    over: Partial<BlockWorkflowStepInput> = {}
  ) => step({ $type: 'repeat', name: 'loop', input: { for: forClause, template }, ...over });
  const overImages = { $ref: '$arguments', path: 'images', as: 'item' };
  const graph = (
    steps: BlockWorkflowStepInput[],
    args: Record<string, unknown> | undefined = ARGS
  ) => resolveBlockWorkflowGraph({ steps, arguments: args });
  const unbounded = (steps: BlockWorkflowStepInput[], args?: Record<string, unknown>) => {
    const r = graph(steps, args);
    if (r.ok) throw new Error('expected a refusal, got a resolved graph');
    expect(r.errorCode).toBe('workflow_repeat_unbounded');
    return r.error;
  };

  it('accepts a repeat over an `arguments` array; its template may read the loop variable, an earlier step and `$arguments`', () => {
    const r = graph([
      step({ name: 'gen' }),
      repeat(overImages, {
        $type: 'wdTagging',
        input: {
          mediaUrl: ref('item', 'url'),
          other: ref('gen'),
          arg: ref('$arguments', 'strength'),
        },
      }),
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.steps[1].stepTypes).toEqual(['repeat', 'wdTagging']);
  });

  it('🔴 refuses a repeat over an EARLIER STEP’s output, naming the step index', () => {
    expect(
      unbounded([
        step({ name: 'frames', $type: 'videoFrameExtraction' }),
        repeat(
          { $ref: 'frames', path: 'output.frames', as: 'frame' },
          { $type: 'wdTagging', input: {} }
        ),
      ])
    ).toBe(
      'workflow step 1: a repeat may only iterate over the workflow\'s own arguments ("$ref": ' +
        '"$arguments"), not "frames" — pass the list in "arguments" instead'
    );
  });

  it('🔴 refuses it in a NESTED template too (the inner loop over the outer loop variable)', () => {
    expect(
      unbounded([
        repeat(overImages, {
          $type: 'repeat',
          input: {
            for: { $ref: 'item', path: 'tiles', as: 'tile' },
            template: { $type: 'wdTagging', input: {} },
          },
        }),
      ])
    ).toContain("workflow step 0: a repeat may only iterate over the workflow's own arguments");
  });

  it('refuses it however `repeat` is cased', () => {
    expect(
      unbounded([
        step({ name: 'frames' }),
        repeat(
          { $ref: 'frames', path: 'output.frames', as: 'f' },
          { $type: 'echo' },
          { $type: 'REPEAT' }
        ),
      ])
    ).toContain('not "frames"');
  });

  it.each([
    ['a path that is missing', 'nope'],
    ['a path to a non-array', 'strength'],
    ['a path through a non-object', 'images.length'],
    ['an inherited key', 'constructor'],
  ])('refuses %s in arguments', (_label, path) => {
    expect(unbounded([repeat({ $ref: '$arguments', path, as: 'i' }, { $type: 'echo' })])).toBe(
      `workflow step 0: repeat "for" path "${path}" does not name an array in "arguments"`
    );
  });

  it('refuses a repeat when the body has no arguments at all', () => {
    const r = resolveBlockWorkflowGraph({ steps: [repeat(overImages, { $type: 'echo' })] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorCode).toBe('workflow_repeat_unbounded');
  });

  it('reads a dotted path', () => {
    expect(
      graph([repeat({ $ref: '$arguments', path: 'a.b', as: 'i' }, { $type: 'echo' })], {
        a: { b: [1, 2] },
      }).ok
    ).toBe(true);
  });

  it('🔴 caps the iteration count at 16', () => {
    expect(WORKFLOW_REPEAT_MAX_ITERATIONS).toBe(16);
    const list = (n: number) => ({ images: Array.from({ length: n }, (_, i) => i) });
    expect(graph([repeat(overImages, { $type: 'echo' })], list(16)).ok).toBe(true);
    expect(unbounded([repeat(overImages, { $type: 'echo' })], list(17))).toBe(
      'workflow step 0: a repeat may run at most 16 iterations, nested repeats multiplied (got 17)'
    );
  });

  it('🔴 multiplies nested repeats: 3 × 5 fits, 3 × 6 does not', () => {
    const nestedOver = (inner: number) =>
      graph(
        [
          repeat(overImages, {
            $type: 'repeat',
            input: {
              for: { $ref: '$arguments', path: 'inner', as: 'j' },
              template: { $type: 'echo', input: {} },
            },
          }),
        ],
        { ...ARGS, inner: Array.from({ length: inner }, (_, i) => i) }
      );
    expect(nestedOver(5).ok).toBe(true);
    const r = nestedOver(6);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorCode).toBe('workflow_repeat_unbounded');
      expect(r.error).toBe(
        'workflow step 0: a repeat may run at most 16 iterations, nested repeats multiplied (got 18)'
      );
    }
  });

  it('🔴 refuses a repeat variable that is also a step name, earlier or later', () => {
    for (const steps of [
      [step({ name: 'item' }), repeat(overImages, { $type: 'echo', input: {} })],
      [repeat(overImages, { $type: 'echo', input: { v: ref('item') } }), step({ name: 'item' })],
    ]) {
      const r = graph(steps);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.errorCode).toBe('workflow_ref_invalid');
        expect(r.error).toBe('a repeat "as" name "item" is also a step name or "$arguments"');
      }
    }
  });

  it('🔴 nested repeats MULTIPLY their generations: 3 × 5 = 15', () => {
    const r = graph(
      [
        repeat(overImages, {
          $type: 'repeat',
          input: {
            for: { $ref: '$arguments', path: 'tiles', as: 'tile' },
            template: { $type: 'echo', input: {} },
          },
        }),
      ],
      { ...ARGS, tiles: [1, 2, 3, 4, 5] }
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.steps[0].generations).toBe(15);
  });

  it('counts generations: one per step, one per iteration of a repeat', () => {
    const r = graph([step(), repeat(overImages, { $type: 'echo', input: {} })]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.steps.map((s) => s.generations)).toEqual([1, 3]);
    const empty = graph([repeat(overImages, { $type: 'echo' })], { images: [] });
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.steps[0].generations).toBe(1);
  });

  it('does not let the loop variable leak outside the template', () => {
    const r = graph([
      repeat(overImages, { $type: 'wdTagging', input: {} }),
      step({ input: { v: ref('item', 'url') } }),
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorCode).toBe('workflow_ref_invalid');
      expect(r.error).toContain('workflow step 1: "$ref": "item" does not name');
    }
  });

  it('refuses a template reference to an unknown source', () => {
    const r = graph([
      repeat(overImages, { $type: 'wdTagging', input: { mediaUrl: ref('elsewhere') } }),
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorCode).toBe('workflow_ref_invalid');
      expect(r.error).toContain('workflow step 0: "$ref": "elsewhere" does not name');
    }
  });
});

describe('collectBlockStepTypes', () => {
  const FOR = { $ref: '$arguments', path: 'items', as: 'item' };
  const SHAPE_ERROR =
    'a repeat step needs exactly { for: { $ref, path, as }, template: { $type, name?, input? } }, nested at most 4 deep';
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
    const args = { items: ['only'] };
    expect(
      resolveBlockWorkflowGraph({
        steps: [{ $type: 'repeat', input: nested(4, 'echo') }],
        arguments: args,
      }).ok
    ).toBe(true);
    const r = resolveBlockWorkflowGraph({
      steps: [{ $type: 'repeat', input: nested(5, 'echo') }],
      arguments: args,
    });
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
      { for: { ...FOR, $Ref: 'x' }, template: { $type: 'echo' } },
    ],
    [
      'a re-cased `path` in the for clause',
      { for: { ...FOR, Path: 'p' }, template: { $type: 'echo' } },
    ],
    [
      'a re-cased `as` in the for clause',
      { for: { ...FOR, AS: 'i' }, template: { $type: 'echo' } },
    ],
    ['an array for clause', { for: [FOR], template: { $type: 'echo' } }],
    [
      'a for clause with no `as`',
      { for: { $ref: '$arguments', path: 'p' }, template: { $type: 'echo' } },
    ],
    [
      'a for clause whose `$ref` is not a string',
      { for: { ...FOR, $ref: 3 }, template: { $type: 'echo' } },
    ],
    [
      'a template `timeout`',
      { for: FOR, template: { $type: 'echo', input: {}, timeout: '01:00:00' } },
    ],
    [
      'a template `priority`',
      { for: FOR, template: { $type: 'echo', input: {}, priority: 'high' } },
    ],
    ['a template `retries`', { for: FOR, template: { $type: 'echo', input: {}, retries: 5 } }],
    ['a template `metadata`', { for: FOR, template: { $type: 'echo', input: {}, metadata: {} } }],
    [
      'a template `name` that is not a string (a reference)',
      { for: FOR, template: { $type: 'echo', name: { $ref: 'loop', path: 'output' }, input: {} } },
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

describe('resolveBlockWorkflowGraph — merge', () => {
  const merge = (fields: Record<string, unknown>, over: Partial<BlockWorkflowStepInput> = {}) =>
    step({ $type: 'merge', input: { onMissing: 'fail', fields }, ...over });
  const field = ($ref: string) => ({ $ref, path: 'output.steps[*].output.tags', reduce: 'push' });
  const SHAPE =
    'a merge step needs a "fields" object whose entries each carry a string "$ref" and a "reduce"';

  it('accepts a merge over EARLIER steps and `$arguments`', () => {
    const steps = resolved([
      step({ name: 'scan' }),
      merge({ tags: field('scan'), arg: field('$arguments') }),
    ]);
    expect(steps).toHaveLength(2);
  });

  it('🔴 refuses a merge field that reads a LATER step, naming the step index', () => {
    const r = refusal([merge({ tags: field('scan') }), step({ name: 'scan' })]);
    expect(r.errorCode).toBe('workflow_ref_invalid');
    expect(r.error).toBe(
      'workflow step 0: "$ref": "scan" does not name "$arguments" or an earlier step'
    );
  });

  it('🔴 refuses a merge field that reads its OWN step', () => {
    const r = refusal([step(), merge({ tags: field('me') }, { name: 'me' })]);
    expect(r.errorCode).toBe('workflow_ref_invalid');
    expect(r.error).toBe(
      'workflow step 1: "$ref": "me" does not name "$arguments" or an earlier step'
    );
  });

  it('🔴 refuses a merge field that reads a step that does not exist', () => {
    const r = refusal([step({ name: 'scan' }), merge({ ok: field('scan'), bad: field('ghost') })]);
    expect(r.errorCode).toBe('workflow_ref_invalid');
    expect(r.error).toBe(
      'workflow step 1: "$ref": "ghost" does not name "$arguments" or an earlier step'
    );
  });

  it('matches `merge` however it is cased', () => {
    expect(isMergeStepType('Merge')).toBe(true);
    const r = refusal([
      merge({ tags: field('later') }, { $type: 'MERGE' }),
      step({ name: 'later' }),
    ]);
    expect(r.error).toContain('workflow step 0: "$ref": "later" does not name');
  });

  it.each([
    ['a re-cased `fields` key', { Fields: { tags: field('ghost') } }],
    [
      'both spellings of `fields`',
      { fields: { ok: field('$arguments') }, Fields: { bad: field('ghost') } },
    ],
    ['no fields', { onMissing: 'fail' }],
    ['fields that are not an object', { fields: [field('ghost')] }],
    ['a field that is not an object', { fields: { tags: 'ghost' } }],
    ['a field with no `$ref`', { fields: { tags: { path: 'p', reduce: 'push' } } }],
    [
      'a field whose `$ref` is re-cased',
      { fields: { tags: { ...field('$arguments'), $Ref: 'ghost' } } },
    ],
    [
      'a field whose `$ref` is not a string',
      { fields: { tags: { $ref: 4, path: 'p', reduce: 'push' } } },
    ],
    [
      'a field with no `reduce` (a plain reference object)',
      { fields: { tags: { $ref: '$arguments', path: 'f' } } },
    ],
  ])('refuses a merge with %s rather than checking it in part', (_label, input) => {
    const r = refusal([step({ $type: 'merge', input: input as Record<string, unknown> })]);
    expect(r.errorCode).toBe('workflow_ref_invalid');
    expect(r.error).toBe(`workflow step 0: ${SHAPE}`);
  });

  it('counts merge sources toward the reference bound', () => {
    const fields = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, field('$arguments')]));
    expect(resolved([merge(fields(64))])).toHaveLength(1);
    const r = refusal([merge(fields(65))]);
    expect(r.error).toBe('workflow step 0: a workflow may hold at most 64 references');
  });

  it('checks a merge that a `repeat` runs, and does not let it read the loop variable', () => {
    const repeatOver = (source: string, extra: BlockWorkflowStepInput[] = []) =>
      resolveBlockWorkflowGraph({
        steps: [
          ...extra,
          step({
            $type: 'repeat',
            input: {
              for: { $ref: '$arguments', path: 'sets', as: 'set' },
              template: { $type: 'merge', input: { fields: { tags: field(source) } } },
            },
          }),
        ],
        arguments: { sets: [1, 2] },
      });
    expect(repeatOver('scan', [step({ name: 'scan' })]).ok).toBe(true);
    const loopVar = repeatOver('set');
    expect(loopVar.ok).toBe(false);
    if (!loopVar.ok) {
      expect(loopVar.error).toBe(
        'workflow step 0: a merge field cannot read the repeat variable "set"'
      );
    }
    const unknown = repeatOver('ghost');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error).toContain('workflow step 0: "$ref": "ghost" does not name');
    }
  });
});
