import { describe, expect, it } from 'vitest';
import {
  baselineState,
  labelsOf,
  promptIdsFor,
  promptKeyOf,
  samePromptIds,
  type LiveState,
} from './baseline';

const ACTIVE = { base: { id: 1 }, 'label:scam': { id: 2 }, 'label:nsfw': { id: 7 } };

describe('promptIdsFor', () => {
  it('maps prompt keys to the harness keys a scan reports', () => {
    expect(promptIdsFor(['scam'], ACTIVE)).toEqual({ base: 1, scam: 2 });
  });

  it('reports 0 for a key the draft overrides', () => {
    expect(promptIdsFor(['scam'], ACTIVE, ['label:scam'])).toEqual({ base: 1, scam: 0 });
  });

  it('names a key with no saved version', () => {
    expect(promptIdsFor(['poi'], ACTIVE)).toBe('label:poi');
  });

  it('round-trips a harness key', () => {
    expect(promptKeyOf('scam')).toBe('label:scam');
    expect(promptKeyOf('base')).toBe('base');
  });
});

describe('labelsOf', () => {
  it('unions the labels of the entity types, in label order', () => {
    expect(labelsOf(['CommentV2', 'Model'])).toEqual(['nsfw', 'poi', 'minor', 'scam']);
  });
});

describe('comparisons', () => {
  it('compares prompt ids regardless of key order', () => {
    expect(samePromptIds({ base: 1, scam: 2 }, { scam: 2, base: 1 })).toBe(true);
    expect(samePromptIds({ base: 1 }, { base: 1, scam: 2 })).toBe(false);
  });
});

describe('baselineState', () => {
  const live: LiveState = { promptIds: { base: 1, scam: 2 }, model: 'm', thinking: false };

  it('is none without a baseline', () => {
    expect(baselineState(null, live)).toBe('none');
  });

  it('is fresh when a done baseline ran the live versions', () => {
    expect(baselineState({ ...live, status: 'done' }, live)).toBe('fresh');
  });

  it('is running while a matching baseline is queued or scanning', () => {
    expect(baselineState({ ...live, status: 'queued' }, live)).toBe('running');
  });

  it('goes stale when a prompt is saved or the model changes', () => {
    expect(baselineState({ ...live, status: 'done', promptIds: { base: 1, scam: 1 } }, live)).toBe(
      'stale'
    );
    expect(baselineState({ ...live, status: 'done', model: 'other' }, live)).toBe('stale');
  });
});
