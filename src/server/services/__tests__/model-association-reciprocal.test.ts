import { describe, expect, it } from 'vitest';
import { planReciprocalAssociations } from '~/server/services/model-association.utils';

const OWNER = 100;
const STRANGER = 200;
const SOURCE = 1;

const plan = (
  candidates: Array<{ modelId: number; ownerId: number | null }>,
  {
    existingCounts = new Map<number, number>(),
    alreadyLinked = new Set<number>(),
    limit = 10,
  }: {
    existingCounts?: Map<number, number>;
    alreadyLinked?: Set<number>;
    limit?: number;
  } = {}
) =>
  planReciprocalAssociations({
    sourceModelId: SOURCE,
    ownerId: OWNER,
    candidates,
    existingCounts,
    alreadyLinked,
    limit,
  });

describe('planReciprocalAssociations', () => {
  it('writes a back-link on a model the owner owns', () => {
    const { create, skipped } = plan([{ modelId: 2, ownerId: OWNER }]);

    expect(create).toEqual([{ fromModelId: 2, toModelId: SOURCE, index: 0 }]);
    expect(skipped).toEqual([]);
  });

  // The safety boundary this whole feature turns on. Before it, nothing in the codebase
  // could write an association row into a model the acting user does not own; reciprocal
  // insertion is the first path that addresses another model at all. If you are here to
  // relax this, the ask that produced it was explicitly "only ones that are theirs".
  it('never writes a back-link on a model owned by someone else', () => {
    const { create, skipped } = plan([
      { modelId: 2, ownerId: OWNER },
      { modelId: 3, ownerId: STRANGER },
    ]);

    expect(create.map((x) => x.fromModelId)).toEqual([2]);
    expect(skipped).toEqual([{ modelId: 3, reason: 'notOwned' }]);
  });

  it('treats an unowned model as someone else, not as the owner', () => {
    const { create, skipped } = plan([{ modelId: 3, ownerId: null }]);

    expect(create).toEqual([]);
    expect(skipped).toEqual([{ modelId: 3, reason: 'notOwned' }]);
  });

  it('does not link a model to itself', () => {
    const { create, skipped } = plan([{ modelId: SOURCE, ownerId: OWNER }]);

    expect(create).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it('skips a target that already carries the back-link', () => {
    const { create, skipped } = plan([{ modelId: 2, ownerId: OWNER }], {
      alreadyLinked: new Set([2]),
      existingCounts: new Map([[2, 3]]),
    });

    expect(create).toEqual([]);
    expect(skipped).toEqual([{ modelId: 2, reason: 'alreadyLinked' }]);
  });

  it('skips a target whose own list is already at the limit', () => {
    const { create, skipped } = plan([{ modelId: 2, ownerId: OWNER }], {
      existingCounts: new Map([[2, 10]]),
      limit: 10,
    });

    expect(create).toEqual([]);
    expect(skipped).toEqual([{ modelId: 2, reason: 'atLimit' }]);
  });

  it('appends after the target list rather than colliding with index 0', () => {
    const { create } = plan([{ modelId: 2, ownerId: OWNER }], {
      existingCounts: new Map([[2, 4]]),
    });

    expect(create).toEqual([{ fromModelId: 2, toModelId: SOURCE, index: 4 }]);
  });

  it('writes one back-link when the same target is listed twice', () => {
    const { create } = plan([
      { modelId: 2, ownerId: OWNER },
      { modelId: 2, ownerId: OWNER },
    ]);

    expect(create).toHaveLength(1);
  });

  it('saves the owned links even when the selection is mixed', () => {
    const { create, skipped } = plan([
      { modelId: 2, ownerId: STRANGER },
      { modelId: 3, ownerId: OWNER },
      { modelId: 4, ownerId: STRANGER },
      { modelId: 5, ownerId: OWNER },
    ]);

    expect(create.map((x) => x.fromModelId)).toEqual([3, 5]);
    expect(skipped.map((x) => x.modelId)).toEqual([2, 4]);
  });
});
