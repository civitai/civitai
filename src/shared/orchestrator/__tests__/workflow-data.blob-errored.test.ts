import { describe, expect, it } from 'vitest';

import { BlobData } from '~/shared/orchestrator/workflow-data';
import type { StepData } from '~/shared/orchestrator/workflow-data';
import type { WorkflowStatus } from '@civitai/client';

/**
 * `errored` is the factual half of the question: the step reached a terminal state
 * and the blob never materialized. Whether that is worth REPORTING is the
 * renderer's call — `GeneratedOutputWrapper` skips its failure card for a canceled
 * step, which is why `canceled` still counts as errored here.
 */
const blob = ({ status, available }: { status?: WorkflowStatus; available: boolean }) =>
  BlobData.from(
    {
      type: 'image',
      id: 'blob-1',
      url: 'https://x/1.png',
      available,
    } as any,
    {
      step: { status, params: {}, metadata: {}, workflow: { metadata: {} } } as unknown as StepData,
      index: 0,
      domain: { green: false } as any,
      nsfwEnabled: true,
      allowMatureContent: true,
    }
  );

describe('BlobData.errored', () => {
  it('is true for a failed step that produced no output', () => {
    expect(blob({ status: 'failed', available: false }).errored).toBe(true);
  });

  it('is true for an expired step that produced no output', () => {
    expect(blob({ status: 'expired', available: false }).errored).toBe(true);
  });

  // The case the getter exists for: the worker finished but the blob never
  // materialized (e.g. the upload failed after the job).
  it('is true for a succeeded step whose output never materialized', () => {
    expect(blob({ status: 'succeeded', available: false }).errored).toBe(true);
  });

  it('is true for a canceled step — presentation decides what to do with that', () => {
    expect(blob({ status: 'canceled', available: false }).errored).toBe(true);
  });

  it('is false while the step is still running', () => {
    expect(blob({ status: 'processing', available: false }).errored).toBe(false);
  });

  it('is false when the step has no status yet', () => {
    expect(blob({ status: undefined, available: false }).errored).toBe(false);
  });

  it('is false whenever the output is available, whatever the status', () => {
    const statuses: WorkflowStatus[] = ['succeeded', 'failed', 'expired', 'canceled'];
    for (const status of statuses) {
      expect(blob({ status, available: true }).errored, status).toBe(false);
    }
  });
});
