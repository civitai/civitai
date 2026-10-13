import { describe, expect, it } from 'vitest';
import {
  UNRATED_REFETCH_MAX_ATTEMPTS,
  selectUnratedRefetch,
} from '~/components/ImageGeneration/utils/unratedOutputRefetch';

const workflow = (id: string, output: Array<Record<string, unknown>>) => ({
  id,
  steps: [{ output }],
});
const image = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  type: 'image',
  available: true,
  ...over,
});

describe('selectUnratedRefetch', () => {
  it('re-fetches a workflow holding an available output with no rating', () => {
    const { workflowIds, blobIds } = selectUnratedRefetch(
      [workflow('wf-1', [image('a')]), workflow('wf-2', [image('b', { nsfwLevel: 'r' })])],
      new Map()
    );

    expect(workflowIds).toEqual(['wf-1']);
    expect(blobIds).toEqual(['a']);
  });

  it('ignores outputs that are rated, blocked, not yet available, or never rated', () => {
    const { workflowIds } = selectUnratedRefetch(
      [
        workflow('rated', [image('a', { nsfwLevel: 'pg' })]),
        workflow('blocked', [image('b', { blockedReason: 'NSFWLevel' })]),
        workflow('pending', [image('c', { available: false })]),
        workflow('audio', [image('d', { type: 'audio' })]),
        workflow('mesh', [image('e', { type: 'model3d' })]),
      ],
      new Map()
    );

    expect(workflowIds).toEqual([]);
  });

  it('includes an unrated video', () => {
    const { workflowIds } = selectUnratedRefetch(
      [workflow('wf-1', [image('a', { type: 'video' })])],
      new Map()
    );

    expect(workflowIds).toEqual(['wf-1']);
  });

  it('stops once an output has used up its attempts', () => {
    const spent = new Map([['a', UNRATED_REFETCH_MAX_ATTEMPTS]]);
    const almost = new Map([['a', UNRATED_REFETCH_MAX_ATTEMPTS - 1]]);

    expect(selectUnratedRefetch([workflow('wf-1', [image('a')])], spent).workflowIds).toEqual([]);
    expect(selectUnratedRefetch([workflow('wf-1', [image('a')])], almost).workflowIds).toEqual([
      'wf-1',
    ]);
  });

  // Attempts are per output, so a new unrated output is not starved by an older one's budget.
  it('keeps re-fetching for a fresh output after another one gave up', () => {
    const spent = new Map([['a', UNRATED_REFETCH_MAX_ATTEMPTS]]);
    const { workflowIds, blobIds } = selectUnratedRefetch(
      [workflow('wf-1', [image('a'), image('b')])],
      spent
    );

    expect(workflowIds).toEqual(['wf-1']);
    expect(blobIds).toEqual(['b']);
  });

  it('lists a workflow once however many outputs it is waiting on', () => {
    const { workflowIds } = selectUnratedRefetch(
      [workflow('wf-1', [image('a'), image('b')]), workflow('wf-1', [image('a'), image('b')])],
      new Map()
    );

    expect(workflowIds).toEqual(['wf-1']);
  });

  it('has a bounded budget', () => {
    expect(UNRATED_REFETCH_MAX_ATTEMPTS).toBeGreaterThan(0);
    expect(UNRATED_REFETCH_MAX_ATTEMPTS).toBeLessThanOrEqual(6);
  });
});
