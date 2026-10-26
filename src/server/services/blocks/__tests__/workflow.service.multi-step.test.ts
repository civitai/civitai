import { describe, expect, it } from 'vitest';
import type { Workflow } from '@civitai/orchestration-client';
import {
  BLOCK_STEP_NAME,
  buildBlockWorkflowStepsMetadata,
  projectAppWorkflow,
  snapshotFromWorkflow,
  WORKFLOW_METADATA_BLOCK_STEPS_KEY,
} from '~/server/services/blocks/workflow.service';

/**
 * The read side of `kind:'workflow'`: which orchestrator steps a snapshot and the
 * queue projection treat as submitted by this bridge, and what each contributes.
 */

const blob = (url: string, over: Record<string, unknown> = {}) => ({
  id: url,
  url,
  available: true,
  type: 'image',
  ...over,
});

type StepRecord = { name: string; suppressOutput?: true };
function workflow(
  steps: Array<Record<string, unknown>>,
  records: StepRecord[] | unknown,
  over: Record<string, unknown> = {}
): Workflow {
  return {
    id: '42-20261012',
    status: 'succeeded',
    createdAt: '2026-10-12T00:00:00Z',
    cost: { total: 64 },
    ...(records === undefined
      ? {}
      : { metadata: { [WORKFLOW_METADATA_BLOCK_STEPS_KEY]: records } }),
    steps,
    ...over,
  } as unknown as Workflow;
}

const GEN = {
  $type: 'imageGen',
  name: 'gen',
  status: 'succeeded',
  output: { images: [blob('https://img/gen-0.png'), blob('https://img/gen-1.png')] },
};
const UPSCALE = {
  $type: 'imageUpscaler',
  name: '$1',
  status: 'succeeded',
  output: { blob: blob('https://img/up.png'), scale: 2 },
};

describe('buildBlockWorkflowStepsMetadata', () => {
  it('records each name, and `suppressOutput` only when it is set', () => {
    expect(
      buildBlockWorkflowStepsMetadata([
        { name: 'gen', suppressOutput: false },
        { name: '$1', suppressOutput: true },
      ])
    ).toEqual([{ name: 'gen' }, { name: '$1', suppressOutput: true }]);
  });
});

describe('snapshotFromWorkflow — kind:workflow', () => {
  it('adds one `steps` entry per recorded step and unions their images', () => {
    const snapshot = snapshotFromWorkflow(
      workflow([GEN, UPSCALE], [{ name: 'gen' }, { name: '$1' }])
    );
    expect(snapshot.imageUrls).toEqual([
      'https://img/gen-0.png',
      'https://img/gen-1.png',
      'https://img/up.png',
    ]);
    expect(snapshot.steps).toEqual([
      {
        name: 'gen',
        $type: 'imageGen',
        status: 'succeeded',
        imageUrls: ['https://img/gen-0.png', 'https://img/gen-1.png'],
      },
      {
        name: '$1',
        $type: 'imageUpscaler',
        status: 'succeeded',
        imageUrls: ['https://img/up.png'],
        // Blobs removed; the rest forwarded.
        output: { scale: 2 },
      },
    ]);
    // A recorded step's output is on its own entry, not the pass-through field.
    expect(snapshot.stepOutputs).toBeUndefined();
    expect(snapshot.cost).toEqual({ total: 64 });
  });

  it('🔴 a `suppressOutput` step contributes to NEITHER image list', () => {
    const snapshot = snapshotFromWorkflow(
      workflow([GEN, UPSCALE], [{ name: 'gen', suppressOutput: true }, { name: '$1' }])
    );
    expect(snapshot.imageUrls).toEqual(['https://img/up.png']);
    expect(snapshot.steps?.[0]).toEqual({ name: 'gen', $type: 'imageGen', status: 'succeeded' });
    expect(snapshot.steps?.[1].imageUrls).toEqual(['https://img/up.png']);
  });

  it('labels the 3D models of a recorded step, and only for urls it publishes', () => {
    const mesh = {
      $type: 'polyGen',
      name: 'mesh',
      status: 'succeeded',
      output: { model: blob('https://img/mesh.glb', { type: 'model3d', format: 'glb' }) },
    };
    const labels = [{ url: 'https://img/mesh.glb', format: 'glb', variant: 'model' }];

    const shown = workflow([GEN, mesh], [{ name: 'gen' }, { name: 'mesh' }]);
    expect(snapshotFromWorkflow(shown).imageUrls).toContain('https://img/mesh.glb');
    expect(snapshotFromWorkflow(shown).model3dOutputs).toEqual(labels);
    expect(projectAppWorkflow(shown).model3dOutputs).toEqual(labels);

    // Suppressed: the url is in no image list, so no label names it either.
    const hidden = workflow([GEN, mesh], [{ name: 'gen' }, { name: 'mesh', suppressOutput: true }]);
    expect('model3dOutputs' in snapshotFromWorkflow(hidden)).toBe(false);
    expect('model3dOutputs' in projectAppWorkflow(hidden)).toBe(false);
  });

  it('omits top-level `imageUrls` when every step that has images suppressed them', () => {
    const snapshot = snapshotFromWorkflow(workflow([GEN], [{ name: 'gen', suppressOutput: true }]));
    expect('imageUrls' in snapshot).toBe(false);
    expect(snapshot.steps).toHaveLength(1);
  });

  it('🔴 drops a step the submit did NOT record, as it always has', () => {
    // Not natively extracted and not recorded: a step this bridge did not submit.
    const stray = { ...UPSCALE, name: 'platform-step' };
    const snapshot = snapshotFromWorkflow(workflow([GEN, stray], [{ name: 'gen' }]));
    expect(snapshot.imageUrls).toEqual(['https://img/gen-0.png', 'https://img/gen-1.png']);
    expect(snapshot.steps?.map((s) => s.name)).toEqual(['gen']);
    expect(snapshot.stepOutputs).toBeUndefined();
  });

  it('maps each step status, and reports a plain-prose failure reason only', () => {
    const snapshot = snapshotFromWorkflow(
      workflow(
        [
          GEN,
          {
            $type: 'transcode',
            name: '$1',
            status: 'failed',
            jobs: [
              { status: 'failed' },
              { status: 'failed', reason: 'The video could not be decoded.' },
            ],
          },
          { $type: 'echo', name: '$2', status: 'unassigned' },
          {
            $type: 'echo',
            name: '$3',
            status: 'canceled',
            jobs: [{ status: 'canceled', reason: 'connect ECONNREFUSED db.internal:5432' }],
          },
          {
            $type: 'echo',
            name: '$4',
            status: 'succeeded',
            jobs: [{ status: 'succeeded', reason: 'not an error' }],
          },
        ],
        [{ name: 'gen' }, { name: '$1' }, { name: '$2' }, { name: '$3' }, { name: '$4' }],
        { status: 'failed', cost: { total: 41 } }
      )
    );
    // A failed workflow still carries what it charged and what it produced.
    expect(snapshot.status).toBe('failed');
    expect(snapshot.cost).toEqual({ total: 41 });
    expect(snapshot.imageUrls).toEqual(['https://img/gen-0.png', 'https://img/gen-1.png']);
    expect(snapshot.steps?.slice(1)).toEqual([
      {
        name: '$1',
        $type: 'transcode',
        status: 'failed',
        error: 'The video could not be decoded.',
      },
      { name: '$2', $type: 'echo', status: 'pending' },
      // An internal-looking reason is withheld, not forwarded.
      { name: '$3', $type: 'echo', status: 'canceled' },
      // A reason on a step that succeeded is not an error.
      { name: '$4', $type: 'echo', status: 'succeeded' },
    ]);
  });

  it('a `repeat` step reports its children, and its own copy of them is not published twice', () => {
    const child = (n: number) => ({
      $type: 'imageUpscaler',
      name: `loop.${n}`,
      status: 'succeeded',
      output: { blob: blob(`https://img/child-${n}.png`) },
    });
    const repeat = {
      $type: 'repeat',
      name: 'loop',
      status: 'succeeded',
      // The orchestrator's repeat output is a copy of the child steps.
      output: { steps: [child(0), child(1)] },
    };
    const snapshot = snapshotFromWorkflow(
      workflow([GEN, repeat, child(0), child(1)], [{ name: 'gen' }, { name: 'loop' }])
    );
    expect(snapshot.imageUrls).toEqual([
      'https://img/gen-0.png',
      'https://img/gen-1.png',
      'https://img/child-0.png',
      'https://img/child-1.png',
    ]);
    expect(snapshot.steps).toEqual([
      expect.objectContaining({ name: 'gen' }),
      { name: 'loop', $type: 'repeat', status: 'succeeded' },
      {
        name: 'loop.0',
        $type: 'imageUpscaler',
        status: 'succeeded',
        imageUrls: ['https://img/child-0.png'],
        output: {},
      },
      {
        name: 'loop.1',
        $type: 'imageUpscaler',
        status: 'succeeded',
        imageUrls: ['https://img/child-1.png'],
        output: {},
      },
    ]);
  });

  it('a suppressed `repeat` suppresses its children too', () => {
    const child = {
      $type: 'imageUpscaler',
      name: 'loop.0',
      status: 'succeeded',
      output: { blob: blob('https://img/child-0.png') },
    };
    const snapshot = snapshotFromWorkflow(
      workflow(
        [{ $type: 'repeat', name: 'loop', status: 'succeeded' }, child],
        [{ name: 'loop', suppressOutput: true }]
      )
    );
    expect('imageUrls' in snapshot).toBe(false);
    expect(snapshot.steps?.[1]).toEqual({
      name: 'loop.0',
      $type: 'imageUpscaler',
      status: 'succeeded',
      output: {},
    });
  });

  it('reports the children of a `repeat` nested inside a `repeat`', () => {
    const grandchild = {
      $type: 'imageUpscaler',
      name: 'loop.0.1',
      status: 'succeeded',
      output: { blob: blob('https://img/grandchild.png') },
    };
    const snapshot = snapshotFromWorkflow(workflow([grandchild], [{ name: 'loop' }]));
    expect(snapshot.imageUrls).toEqual(['https://img/grandchild.png']);
    expect(snapshot.steps?.map((s) => s.name)).toEqual(['loop.0.1']);
  });

  it('maps an `expired` step', () => {
    const snapshot = snapshotFromWorkflow(
      workflow([{ $type: 'echo', name: 'a', status: 'expired' }], [{ name: 'a' }])
    );
    expect(snapshot.steps).toEqual([{ name: 'a', $type: 'echo', status: 'expired' }]);
  });

  it('does not treat a look-alike name as a child of a recorded step', () => {
    const lookalikes = ['loop.x', 'loopy.0', 'loop.0.png', 'other.0'].map((name) => ({
      ...UPSCALE,
      name,
    }));
    const snapshot = snapshotFromWorkflow(workflow(lookalikes, [{ name: 'loop' }]));
    expect(snapshot.steps).toBeUndefined();
    expect('imageUrls' in snapshot).toBe(false);
  });

  it('a step whose `$type` has its own extraction gets no raw `output`', () => {
    // `chatCompletion` is a registered text step: its prose is published only
    // after a scan, on `textOutputs`, never raw on the step entry.
    const snapshot = snapshotFromWorkflow(
      workflow(
        [
          {
            $type: 'chatCompletion',
            name: 'write',
            status: 'succeeded',
            output: { choices: [{ message: { role: 'assistant', content: 'secret prose' } }] },
          },
        ],
        [{ name: 'write' }]
      )
    );
    expect(snapshot.steps).toEqual([
      { name: 'write', $type: 'chatCompletion', status: 'succeeded' },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('secret prose');
  });

  it.each([
    ['absent', undefined],
    ['not an array', { name: 'gen' }],
    ['empty', []],
    ['an entry without a name', [{ name: 'gen' }, { suppressOutput: true }]],
    ['an entry that is not an object', ['gen']],
  ])('ignores a record that is %s: the snapshot is what it was before', (_label, records) => {
    const snapshot = snapshotFromWorkflow(workflow([GEN, UPSCALE], records));
    expect('steps' in snapshot).toBe(false);
    // The unrecorded pass-through step is dropped, exactly as before.
    expect(snapshot.imageUrls).toEqual(['https://img/gen-0.png', 'https://img/gen-1.png']);
  });

  it('leaves a single-step pass-through snapshot byte-identical', () => {
    const passThrough = { ...UPSCALE, name: BLOCK_STEP_NAME };
    expect(snapshotFromWorkflow(workflow([passThrough], undefined))).toEqual({
      workflowId: '42-20261012',
      status: 'succeeded',
      cost: { total: 64 },
      imageUrls: ['https://img/up.png'],
      stepOutputs: [{ $type: 'imageUpscaler', output: { scale: 2 } }],
    });
  });

  it('reports the trained epochs and the published model of a recorded training step', () => {
    const training = {
      $type: 'training',
      name: 'train',
      status: 'succeeded',
      output: {
        moderationStatus: 'approved',
        epochs: [{ epochNumber: 1, model: blob('https://m/e1.safetensors') }],
      },
    };
    const snapshot = snapshotFromWorkflow(
      workflow([training], [{ name: 'train' }], {
        metadata: {
          [WORKFLOW_METADATA_BLOCK_STEPS_KEY]: [{ name: 'train' }],
          modelId: 7,
          modelVersionId: 9,
        },
      })
    );
    expect(snapshot.trainedEpochs).toEqual([{ $type: 'training', epochNumber: 1 }]);
    expect(snapshot.publishedModel).toEqual({ modelId: 7, modelVersionId: 9, published: false });
    // The checkpoint itself is in neither channel.
    expect(JSON.stringify(snapshot)).not.toContain('safetensors');
  });
});

describe('a suppressed TRAINING step still reports its ready epochs', () => {
  const training = {
    $type: 'training',
    name: 'train',
    status: 'succeeded',
    output: {
      moderationStatus: 'approved',
      epochs: [
        {
          epochNumber: 2,
          model: blob('https://m/e2.safetensors'),
          samples: [blob('https://img/s.png')],
        },
      ],
    },
  };
  const record = [{ name: 'train', suppressOutput: true as const }];

  it('on the snapshot', () => {
    const snapshot = snapshotFromWorkflow(workflow([training], record));
    expect(snapshot.trainedEpochs).toEqual([{ $type: 'training', epochNumber: 2 }]);
    expect('imageUrls' in snapshot).toBe(false);
  });

  it('on the queue projection', () => {
    const projection = projectAppWorkflow(workflow([training], record));
    expect(projection.trainedEpochs).toEqual([{ $type: 'training', epochNumber: 2 }]);
    expect(projection.images).toEqual([]);
  });
});

describe('projectAppWorkflow — kind:workflow', () => {
  it('publishes a recorded step’s images, but not a suppressed step’s', () => {
    const projection = projectAppWorkflow(
      workflow([GEN, UPSCALE], [{ name: 'gen', suppressOutput: true }, { name: '$1' }])
    );
    expect(projection.images.map((i) => i.url)).toEqual(['https://img/up.png']);
  });

  it('publishes a `repeat` step’s children once, and never its own copy', () => {
    const child = {
      $type: 'imageUpscaler',
      name: 'loop.0',
      status: 'succeeded',
      output: { blob: blob('https://img/child-0.png') },
    };
    const projection = projectAppWorkflow(
      workflow(
        [{ $type: 'repeat', name: 'loop', status: 'succeeded', output: { steps: [child] } }, child],
        [{ name: 'loop' }]
      )
    );
    expect(projection.images.map((i) => i.url)).toEqual(['https://img/child-0.png']);
  });

  it('still drops an unrecorded pass-through step', () => {
    const projection = projectAppWorkflow(
      workflow([{ ...UPSCALE, name: 'stray' }], [{ name: 'gen' }])
    );
    expect(projection.images).toEqual([]);
  });

  it('is unchanged for a workflow with no record', () => {
    const projection = projectAppWorkflow(
      workflow([GEN, { ...UPSCALE, name: BLOCK_STEP_NAME }], undefined)
    );
    expect(projection.images.map((i) => i.url)).toEqual([
      'https://img/gen-0.png',
      'https://img/gen-1.png',
      'https://img/up.png',
    ]);
  });
});
