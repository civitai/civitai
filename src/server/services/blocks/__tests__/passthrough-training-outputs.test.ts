import { describe, expect, it, vi } from 'vitest';
import type { Blob, ImageResourceTrainingOutput, TrainingOutput, Workflow } from '@civitai/client';
import type * as CoverageSource from '~/server/services/generation/coverage-source';

/**
 * A pass-through `training` / `imageResourceTraining` step (civitai-app-starters#541).
 *
 * 🔴 THE NEGATIVE PROPERTY IS THE POINT: the trained checkpoint must reach the
 * block on NO channel — not `imageUrls`, not `stepOutputs`, not
 * `AppWorkflow.images` — while the epoch SAMPLE images still reach `imageUrls`.
 * Each checkpoint url / name below is distinct from every sample url, so a
 * `not.toContain` cannot pass by the two coinciding.
 */

vi.mock('~/server/services/generation/coverage-source', async (importOriginal) => ({
  ...(await importOriginal<typeof CoverageSource>()),
  nextCoverageEnabled: async () => false,
}));

import { BLOCK_STEP_NAME, projectAppWorkflow, snapshotFromWorkflow } from '../workflow.service';

const CKPT_1 = 'https://blobs.example/ckpt-epoch-1.safetensors';
const CKPT_2 = 'https://blobs.example/ckpt-epoch-2.safetensors';
const CKPT_3_PENDING = 'https://blobs.example/ckpt-epoch-3-pending.safetensors';
const SAMPLE_1A = 'https://blobs.example/sample-1a.jpeg';
const SAMPLE_1B = 'https://blobs.example/sample-1b.jpeg';
const SAMPLE_2A = 'https://blobs.example/sample-2a.jpeg';

function blob(url: string, available = true, type = 'image'): Blob {
  return {
    type,
    id: url.split('/').pop() as string,
    available,
    url,
    urlExpiresAt: '2026-10-06T00:00:00Z',
    jobId: 'job_1',
    nsfwLevel: 'pg',
  };
}

/** A realistic AI-Toolkit `TrainingOutput`: two finished epochs and one still uploading. */
function trainingOutput(): TrainingOutput {
  return {
    moderationStatus: 'approved',
    epochs: [
      {
        epochNumber: 1,
        model: blob(CKPT_1, true, 'model'),
        samples: [blob(SAMPLE_1A), blob(SAMPLE_1B)],
      },
      { epochNumber: 2, model: blob(CKPT_2, true, 'model'), samples: [blob(SAMPLE_2A)] },
      { epochNumber: 3, model: blob(CKPT_3_PENDING, false, 'model'), samples: [] },
    ],
  };
}

const LEGACY_CKPT_URL = 'https://blobs.example/legacy-epoch-5.safetensors?sig=abc';
const LEGACY_CKPT_NAME = 'legacy-lora_epoch_5.safetensors';
// The main app renders `sampleImages` entries as image urls (`TrainingSelectFile`).
const LEGACY_SAMPLE_URL = 'https://blobs.example/legacy-epoch-5-sample-0.jpeg';

/** A realistic legacy `ImageResourceTrainingOutput`: checkpoints are PLAIN STRINGS. */
function imageResourceTrainingOutput(): ImageResourceTrainingOutput {
  return {
    moderationStatus: 'approved',
    epochs: [
      {
        epochNumber: 5,
        blobName: LEGACY_CKPT_NAME,
        blobSize: 228_458_712,
        // '' is a failed sample's slot (see `sampleSlotUrl`), not an image.
        sampleImages: ['', LEGACY_SAMPLE_URL],
        blobUrl: LEGACY_CKPT_URL,
      },
      // Not uploaded yet: no url, so no epoch to hand the wizard.
      {
        epochNumber: 6,
        blobName: 'legacy-lora_epoch_6.safetensors',
        sampleImages: [],
        blobUrl: '',
      },
    ],
    sampleImagesPrompts: ['a photo of sks dog'],
    storedAsAssets: false,
    eta: 0,
  };
}

function workflow(
  $type: string,
  output: unknown,
  extra: { name?: string; metadata?: Record<string, unknown> } = {}
): Workflow {
  return {
    id: 'wf_train_1',
    status: 'succeeded',
    createdAt: '2026-10-05T00:00:00Z',
    cost: { total: 500 },
    ...(extra.metadata ? { metadata: extra.metadata } : {}),
    steps: [{ $type, name: extra.name ?? BLOCK_STEP_NAME, output }],
  } as unknown as Workflow;
}

describe('pass-through `training` step — the checkpoint never rides out', () => {
  it('puts ONLY the epoch samples on imageUrls', () => {
    const snap = snapshotFromWorkflow(workflow('training', trainingOutput()));
    expect(snap.imageUrls).toEqual([SAMPLE_1A, SAMPLE_1B, SAMPLE_2A]);
  });

  it('carries no checkpoint url anywhere in the snapshot, the pending one included', () => {
    const wire = JSON.stringify(snapshotFromWorkflow(workflow('training', trainingOutput())));
    for (const url of [CKPT_1, CKPT_2, CKPT_3_PENDING]) expect(wire).not.toContain(url);
  });

  it('keeps the rest of the epoch in stepOutputs, minus `model`', () => {
    const snap = snapshotFromWorkflow(workflow('training', trainingOutput()));
    expect(snap.stepOutputs).toEqual([
      {
        $type: 'training',
        output: {
          moderationStatus: 'approved',
          epochs: [
            { epochNumber: 1, samples: [] },
            { epochNumber: 2, samples: [] },
            { epochNumber: 3, samples: [] },
          ],
        },
      },
    ]);
  });

  it('keeps the checkpoint out of AppWorkflow.images (the publish path)', () => {
    const projected = projectAppWorkflow(workflow('training', trainingOutput()));
    expect(projected.images.map((i) => i.url)).toEqual([SAMPLE_1A, SAMPLE_1B, SAMPLE_2A]);
    expect(JSON.stringify(projected)).not.toContain('.safetensors');
  });
});

describe('pass-through `imageResourceTraining` step — the plain-string checkpoint', () => {
  it('drops the checkpoint, lifts the sample urls to imageUrls, and forwards the rest', () => {
    const snap = snapshotFromWorkflow(
      workflow('imageResourceTraining', imageResourceTrainingOutput())
    );
    const wire = JSON.stringify(snap);
    expect(wire).not.toContain(LEGACY_CKPT_URL);
    expect(wire).not.toContain(LEGACY_CKPT_NAME);
    expect(snap.stepOutputs).toEqual([
      {
        $type: 'imageResourceTraining',
        output: {
          moderationStatus: 'approved',
          epochs: [{ epochNumber: 5, blobSize: 228_458_712 }, { epochNumber: 6 }],
          sampleImagesPrompts: ['a photo of sks dog'],
          storedAsAssets: false,
          eta: 0,
        },
      },
    ]);
    expect(snap.imageUrls).toEqual([LEGACY_SAMPLE_URL]);
  });

  it('surfaces the sample urls on AppWorkflow.images (the publish path), never the checkpoint', () => {
    const projected = projectAppWorkflow(
      workflow('imageResourceTraining', imageResourceTrainingOutput())
    );
    expect(projected.images).toEqual([
      { url: LEGACY_SAMPLE_URL, width: null, height: null, nsfwLevel: null },
    ]);
  });
});

describe('trainedEpochs', () => {
  it('lists the training epochs whose checkpoint is available, skipping the pending one', () => {
    const snap = snapshotFromWorkflow(workflow('training', trainingOutput()));
    expect(snap.trainedEpochs).toEqual([
      { $type: 'training', epochNumber: 1 },
      { $type: 'training', epochNumber: 2 },
    ]);
  });

  it('lists the imageResourceTraining epochs that have a checkpoint url', () => {
    const snap = snapshotFromWorkflow(
      workflow('imageResourceTraining', imageResourceTrainingOutput())
    );
    expect(snap.trainedEpochs).toEqual([{ $type: 'imageResourceTraining', epochNumber: 5 }]);
  });

  it('is OMITTED for a training step with no ready checkpoint yet', () => {
    const snap = snapshotFromWorkflow(
      workflow('training', {
        moderationStatus: 'approved',
        epochs: [{ epochNumber: 1, model: blob(CKPT_3_PENDING, false, 'model'), samples: [] }],
      })
    );
    expect(snap).not.toHaveProperty('trainedEpochs');
  });

  // A non-training `$type` with the SAME output shape: the rule is keyed on the
  // `$type`, so its `model` blob still takes the generic route — the control
  // that shows the training rule is not a general strip.
  it('is OMITTED, and nothing is dropped, for a non-training $type with the same shape', () => {
    const snap = snapshotFromWorkflow(workflow('imageBackgroundRemoval', trainingOutput()));
    expect(snap).not.toHaveProperty('trainedEpochs');
    expect(snap.imageUrls).toEqual([CKPT_1, SAMPLE_1A, SAMPLE_1B, CKPT_2, SAMPLE_2A]);
  });

  it('is OMITTED for a training step this bridge did not submit', () => {
    const snap = snapshotFromWorkflow(workflow('training', trainingOutput(), { name: 'other' }));
    expect(snap).not.toHaveProperty('trainedEpochs');
    expect(snap.imageUrls).toBeUndefined();
  });

  it.each(['evaluating', 'underReview', 'rejected', undefined])(
    'is OMITTED when the run moderationStatus is %s, while samples still surface',
    (moderationStatus) => {
      const snap = snapshotFromWorkflow(
        workflow('training', { ...trainingOutput(), moderationStatus })
      );
      expect(snap).not.toHaveProperty('trainedEpochs');
      expect(snap.imageUrls).toEqual([SAMPLE_1A, SAMPLE_1B, SAMPLE_2A]);
      expect(JSON.stringify(snap)).not.toContain('.safetensors');
    }
  );

  it('accumulates across two training steps rather than keeping the last', () => {
    const wf = workflow('training', trainingOutput());
    (wf.steps as unknown[]).push({
      $type: 'imageResourceTraining',
      name: BLOCK_STEP_NAME,
      output: imageResourceTrainingOutput(),
    });
    expect(snapshotFromWorkflow(wf).trainedEpochs).toEqual([
      { $type: 'training', epochNumber: 1 },
      { $type: 'training', epochNumber: 2 },
      { $type: 'imageResourceTraining', epochNumber: 5 },
    ]);
  });
});

// The AppWorkflow LIST row (`useAppWorkflows`) carries the same field, so a block
// listing its runs can hand an approved one to the publish wizard without
// polling each workflow.
describe('trainedEpochs on AppWorkflow rows', () => {
  it('lists the ready epochs of an approved `training` run', () => {
    expect(projectAppWorkflow(workflow('training', trainingOutput())).trainedEpochs).toEqual([
      { $type: 'training', epochNumber: 1 },
      { $type: 'training', epochNumber: 2 },
    ]);
  });

  it('lists the ready epochs of an approved `imageResourceTraining` run', () => {
    expect(
      projectAppWorkflow(workflow('imageResourceTraining', imageResourceTrainingOutput()))
        .trainedEpochs
    ).toEqual([{ $type: 'imageResourceTraining', epochNumber: 5 }]);
  });

  it('accumulates across two training steps rather than keeping the last', () => {
    const wf = workflow('training', trainingOutput());
    (wf.steps as unknown[]).push({
      $type: 'imageResourceTraining',
      name: BLOCK_STEP_NAME,
      output: imageResourceTrainingOutput(),
    });
    expect(projectAppWorkflow(wf).trainedEpochs).toEqual([
      { $type: 'training', epochNumber: 1 },
      { $type: 'training', epochNumber: 2 },
      { $type: 'imageResourceTraining', epochNumber: 5 },
    ]);
  });

  it.each(['evaluating', 'underReview', 'rejected', undefined])(
    'is OMITTED when the run moderationStatus is %s',
    (moderationStatus) => {
      const projected = projectAppWorkflow(
        workflow('training', { ...trainingOutput(), moderationStatus })
      );
      expect(projected).not.toHaveProperty('trainedEpochs');
      expect(projected.images.map((i) => i.url)).toEqual([SAMPLE_1A, SAMPLE_1B, SAMPLE_2A]);
    }
  );

  it('is OMITTED for a training step this bridge did not submit', () => {
    expect(
      projectAppWorkflow(workflow('training', trainingOutput(), { name: 'other' }))
    ).not.toHaveProperty('trainedEpochs');
  });

  // Same output shape, non-training `$type`: the row keeps exactly its prior keys.
  it('is OMITTED for a non-training row, which keeps exactly its prior keys', () => {
    const projected = projectAppWorkflow(workflow('imageBackgroundRemoval', trainingOutput()));
    expect(Object.keys(projected).sort()).toEqual(
      ['cost', 'createdAt', 'images', 'status', 'workflowId'].sort()
    );
  });
});

describe('publishedModel', () => {
  const stamped = { modelId: 501, modelVersionId: 9001 };

  it('reports a published model on the snapshot and on AppWorkflow', () => {
    const wf = workflow('training', trainingOutput(), {
      metadata: { ...stamped, published: true },
    });
    const expected = { modelId: 501, modelVersionId: 9001, published: true };
    expect(snapshotFromWorkflow(wf).publishedModel).toEqual(expected);
    expect(projectAppWorkflow(wf).publishedModel).toEqual(expected);
  });

  it('reports a still-draft model (ids stamped, `published` absent) as published: false', () => {
    const wf = workflow('imageResourceTraining', imageResourceTrainingOutput(), {
      metadata: stamped,
    });
    const expected = { modelId: 501, modelVersionId: 9001, published: false };
    expect(snapshotFromWorkflow(wf).publishedModel).toEqual(expected);
    expect(projectAppWorkflow(wf).publishedModel).toEqual(expected);
  });

  it.each([
    ['a zero id', { modelId: 0, modelVersionId: 9001 }],
    ['a negative id', { modelId: 501, modelVersionId: -1 }],
    ['a fractional id', { modelId: 501.5, modelVersionId: 9001 }],
    ['a numeric string', { modelId: '501', modelVersionId: 9001 }],
    ['a missing version id', { modelId: 501, published: true }],
  ])('is OMITTED for %s', (_label, metadata) => {
    const wf = workflow('training', trainingOutput(), { metadata });
    expect(snapshotFromWorkflow(wf)).not.toHaveProperty('publishedModel');
    expect(projectAppWorkflow(wf)).not.toHaveProperty('publishedModel');
  });

  it('is OMITTED for a training step this bridge did not submit, ids stamped or not', () => {
    const wf = workflow('training', trainingOutput(), { name: 'other', metadata: stamped });
    expect(snapshotFromWorkflow(wf)).not.toHaveProperty('publishedModel');
    expect(projectAppWorkflow(wf)).not.toHaveProperty('publishedModel');
  });

  it('is OMITTED for a non-training workflow whose metadata happens to carry the ids', () => {
    const wf = workflow('imageBackgroundRemoval', { blobs: [] }, { metadata: stamped });
    expect(snapshotFromWorkflow(wf)).not.toHaveProperty('publishedModel');
    expect(Object.keys(projectAppWorkflow(wf)).sort()).toEqual(
      ['cost', 'createdAt', 'images', 'status', 'workflowId'].sort()
    );
  });
});
