import { describe, expect, it } from 'vitest';
import { datasetEpoch, planRemoval } from './datasetRemoval';
import type { Img } from './trainingFlow';

const img = (id: number): Img =>
  ({
    id,
    name: `${id}.png`,
    previewUrl: '',
    mediaType: 'image',
    status: 'uploaded',
    progress: 1,
    tags: [],
    caption: '',
  } as Img);

describe('planRemoval', () => {
  const images = [img(1), img(2), img(3)];

  it('a full clear stops a running label pass', () => {
    const plan = planRemoval(images, [1, 2, 3], true);
    expect(plan.kept).toEqual([]);
    expect(plan.removed.map((i) => i.id)).toEqual([1, 2, 3]);
    expect(plan.abortLabelPass).toBe(true);
  });

  it('a partial removal keeps the rest and lets the pass finish', () => {
    const plan = planRemoval(images, [2], true);
    expect(plan.kept.map((i) => i.id)).toEqual([1, 3]);
    expect(plan.abortLabelPass).toBe(false);
  });

  it('nothing to abort when no pass is running', () => {
    expect(planRemoval(images, [1, 2, 3], false).abortLabelPass).toBe(false);
  });

  it('ids not in the dataset remove nothing and abort nothing', () => {
    const plan = planRemoval(images, [9], true);
    expect(plan.kept).toHaveLength(3);
    expect(plan.abortLabelPass).toBe(false);
  });
});

describe('datasetEpoch', () => {
  it('an ingress captured before a clear is stale after it', () => {
    const epoch = datasetEpoch();
    const before = epoch.capture();
    expect(before()).toBe(true);
    epoch.bump();
    expect(before()).toBe(false);
    expect(epoch.capture()()).toBe(true);
  });
});
