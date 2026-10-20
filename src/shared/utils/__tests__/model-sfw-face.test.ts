import { describe, expect, it } from 'vitest';
import {
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
  allBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import {
  normalizeSfwFaceInput,
  resolveModelFace,
  showsSfwFace,
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
