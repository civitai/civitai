import { describe, expect, it } from 'vitest';
import {
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
  allBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import {
  comCoverState,
  comFaceRemovedMessage,
  hasCompleteSfwFace,
  hoistCoverImage,
  normalizeSfwFaceInput,
  pickCoverImageId,
  resolveModelFace,
  showsSfwFace,
  withSfwModelNames,
} from '~/shared/utils/model-sfw-face';

const model = {
  id: 1,
  name: 'Red title',
  description: '<p>Red description</p>',
  sfwName: 'Com title',
  sfwDescription: '<p>Com description</p>',
};

describe('showsSfwFace', () => {
  it('is on for the .com and signed-out levels and off once a mature bit is selected', () => {
    expect(showsSfwFace(publicBrowsingLevelsFlag)).toBe(true);
    expect(showsSfwFace(sfwBrowsingLevelsFlag)).toBe(true);
    expect(showsSfwFace(allBrowsingLevelsFlag)).toBe(false);
  });

  it('keeps the .red face when no viewer level is known', () => {
    expect(showsSfwFace(undefined)).toBe(false);
    expect(showsSfwFace(0)).toBe(false);
  });
});

describe('resolveModelFace', () => {
  it('swaps in the .com face and never ships the stored pair', () => {
    const resolved = resolveModelFace(model, true);
    expect(resolved).toEqual({ id: 1, name: 'Com title', description: '<p>Com description</p>' });
  });

  it('shows no description rather than the .red one when the .com description is blank', () => {
    const resolved = resolveModelFace({ ...model, sfwDescription: null }, true);
    expect(resolved.description).toBeNull();
  });

  it('keeps the .red face for a mature viewer or a model with no face', () => {
    expect(resolveModelFace(model, false).name).toBe('Red title');
    expect(resolveModelFace({ ...model, sfwName: null }, true).name).toBe('Red title');
  });

  it('adds no description key to a row that never selected one', () => {
    const resolved = resolveModelFace({ id: 1, name: 'Red title', sfwName: 'Com title' }, true);
    expect('description' in resolved).toBe(false);
  });

  it('does not mutate the source row', () => {
    const row = { ...model };
    resolveModelFace(row, true);
    expect(row).toEqual(model);
  });
});

describe('withSfwModelNames', () => {
  const rows = [
    { modelId: 1, modelName: 'Red title', versionName: 'v1' },
    { modelId: 2, modelName: 'No face', versionName: 'v2' },
  ];

  it('renames only the models that have a face', () => {
    expect(withSfwModelNames(rows, new Map([[1, 'Com title']]))).toEqual([
      { modelId: 1, modelName: 'Com title', versionName: 'v1' },
      { modelId: 2, modelName: 'No face', versionName: 'v2' },
    ]);
  });

  it('leaves the rows untouched for a viewer who gets the .red face', () => {
    expect(withSfwModelNames(rows, new Map())).toEqual(rows);
  });

  it('does not write into rows shared with a cache', () => {
    withSfwModelNames(rows, new Map([[1, 'Com title']]));
    expect(rows[0].modelName).toBe('Red title');
  });
});

describe('normalizeSfwFaceInput', () => {
  it('stores a cleared title or empty RTE document as NULL', () => {
    const data = { sfwName: '  ', sfwDescription: '<p></p>' };
    normalizeSfwFaceInput(data);
    expect(data).toEqual({ sfwName: null, sfwDescription: null });
  });

  it('clears the description when the face is turned off', () => {
    const data = { sfwName: null, sfwDescription: '<p>left behind</p>' };
    normalizeSfwFaceInput(data);
    expect(data.sfwDescription).toBeNull();
  });

  it('leaves a write that does not carry the face untouched', () => {
    const data: { sfwName?: string | null; sfwDescription?: string | null } = {};
    normalizeSfwFaceInput(data);
    expect(data).toEqual({});
  });
});

describe('hasCompleteSfwFace', () => {
  const mature = 60;
  it('needs a title, a cover and the safe bits the level computation adds for that cover', () => {
    expect(hasCompleteSfwFace({ sfwName: 'x', sfwCoverImageId: 1, nsfwLevel: mature | 1 })).toBe(
      true
    );
    // A cover the computation rejected (moderated, deleted, not the creator's) leaves no safe bits.
    expect(hasCompleteSfwFace({ sfwName: 'x', sfwCoverImageId: 1, nsfwLevel: mature })).toBe(false);
    expect(hasCompleteSfwFace({ sfwName: null, sfwCoverImageId: 1, nsfwLevel: 1 })).toBe(false);
    expect(hasCompleteSfwFace({ sfwName: 'x', sfwCoverImageId: null, nsfwLevel: 1 })).toBe(false);
  });
});

describe('pickCoverImageId', () => {
  const model = { hasSfwFace: true, coverImageId: 10, sfwCoverImageId: 20 };
  it('gives the .com cover only to a face viewer of a model with a complete face', () => {
    expect(pickCoverImageId(model, true)).toBe(20);
    expect(pickCoverImageId(model, false)).toBe(10);
    expect(pickCoverImageId({ ...model, hasSfwFace: false }, true)).toBe(10);
    expect(pickCoverImageId({ hasSfwFace: false }, true)).toBeNull();
  });
});

describe('hoistCoverImage', () => {
  const images = [{ id: 1 }, { id: 2 }, { id: 3 }];
  it('moves the cover to the front without duplicating it', () => {
    expect(hoistCoverImage(images, { id: 3 }).map((i) => i.id)).toEqual([3, 1, 2]);
    expect(hoistCoverImage(images, { id: 9 }).map((i) => i.id)).toEqual([9, 1, 2, 3]);
    expect(hoistCoverImage(images, undefined)).toBe(images);
  });
});

describe('comCoverState', () => {
  const counts = {
    nsfwLevel: 1,
    needsReview: null,
    tosViolation: false,
    acceptableMinor: false,
    blockedFor: null,
    ingestion: 'Scanned',
    ownPost: true,
    postPublished: true,
    sameModel: true,
    versionPublished: true,
  };

  it('is null for a cover that lists the model', () => {
    expect(comCoverState(counts)).toBeNull();
  });

  // Moderation decision: waiting on a moderator must read the same as being flagged. Do not map any
  // review state to `scanning`, which would tell the owner a review is under way.
  it.each(['minor', 'csam', 'poi', 'tag'])(
    'says an image under %s review cannot be used, not that it is being reviewed',
    (needsReview) => {
      expect(comCoverState({ ...counts, needsReview })).toBe('unusable');
      expect(comCoverState({ ...counts, needsReview, ingestion: 'Pending' })).toBe('unusable');
    }
  );

  it.each([
    { tosViolation: true },
    { acceptableMinor: true },
    { blockedFor: 'tos' },
    { ingestion: 'Blocked' },
    { ingestion: 'PendingManualAssignment' },
    { nsfwLevel: 4 },
  ])('says an image with %o cannot be used', (flag) => {
    expect(comCoverState({ ...counts, ...flag })).toBe('unusable');
  });

  it.each([{ tosViolation: true }, { acceptableMinor: true }, { blockedFor: 'tos' }])(
    'says an unscanned image with %o cannot be used, not that it is being reviewed',
    (flag) => {
      expect(comCoverState({ ...counts, ingestion: 'Pending', ...flag })).toBe('unusable');
    }
  );

  it('says a missing image cannot be used', () => {
    expect(comCoverState(null)).toBe('unusable');
  });

  it('says only an unflagged image the scanner has not finished is being reviewed', () => {
    expect(comCoverState({ ...counts, ingestion: 'Pending', nsfwLevel: 0 })).toBe('scanning');
  });

  it.each([
    { sameModel: false },
    { versionPublished: false },
    { postPublished: false },
    { ownPost: false },
  ])('asks for a cover from this model’s published version when %o', (miss) => {
    expect(comCoverState({ ...counts, ...miss })).toBe('version');
  });
});

describe('comFaceRemovedMessage', () => {
  it('tells a removal without a verdict apart from a refusal', () => {
    expect(comFaceRemovedMessage('recheck-unverified', true)).toMatch(/not a decision/);
    expect(comFaceRemovedMessage('detected', true)).not.toMatch(/not a decision/);
  });

  it('does not tell a non-mature model it left civitai.com', () => {
    expect(comFaceRemovedMessage('detected', false)).toMatch(/still on civitai\.com/);
    expect(comFaceRemovedMessage('recheck-unverified', false)).toBeNull();
  });
});
