import { describe, expect, it } from 'vitest';
import { parseCheckInput } from './input';
import {
  editedPromptKeys,
  itemChanged,
  judgeCandidates,
  runIsStale,
  sourceTypeOf,
  type TryItem,
} from './try';
import { LAB_ENTITY_TYPES } from './types';

const AS = { lookupAs: 'Article', profileAs: 'User' } as const;

describe('sourceTypeOf', () => {
  it('reads the type from the input, the look-up choice or the profile choice', () => {
    expect(sourceTypeOf(parseCheckInput('https://civitai.com/models/7'), AS)).toBe('Model');
    expect(sourceTypeOf(parseCheckInput('7 8'), AS)).toBe('Article');
    expect(sourceTypeOf(parseCheckInput('https://civitai.com/user/someone'), AS)).toBe('User');
    expect(sourceTypeOf(parseCheckInput('plain words'), AS)).toBeNull();
  });
});

describe('judgeCandidates', () => {
  it('offers every type for text when only the general instructions are edited', () => {
    expect(judgeCandidates(null, ['base'])).toEqual([...LAB_ENTITY_TYPES]);
    expect(judgeCandidates(null, [])).toEqual([...LAB_ENTITY_TYPES]);
  });

  it('offers only the types that use an edited label', () => {
    expect(judgeCandidates(null, ['label:scam'])).toEqual([
      'ChatMessage',
      'Comment',
      'CommentV2',
      'ResourceReview',
      'User',
      'UserProfile',
    ]);
  });

  it('judges a link as its own type', () => {
    expect(judgeCandidates('Model', ['label:nsfw'])).toEqual(['Model']);
    expect(judgeCandidates('Model', [])).toEqual(['Model']);
  });

  it('keeps a link type that uses none of the edited labels rather than offering nothing', () => {
    expect(judgeCandidates('Article', ['label:scam'])).toEqual(['Article']);
  });
});

describe('editedPromptKeys', () => {
  it('lists the prompt keys the drafts touch, in key order', () => {
    expect(editedPromptKeys({ base: 'B' })).toEqual(['base']);
    expect(editedPromptKeys({ 'label:scam': 'S', base: 'B' })).toEqual(['base', 'label:scam']);
    expect(editedPromptKeys({})).toEqual([]);
  });
});

const scam = (detected: boolean) => ({
  key: 'k',
  ok: true as const,
  workflowId: 'wf',
  promptIds: {},
  output: { scam: { detected, reason: '' } },
  elapsedMs: 1,
});
const item = (current: boolean, edited: boolean | null): TryItem => ({
  key: 'k',
  title: 't',
  fields: [],
  entityId: null,
  authorId: null,
  current: scam(current),
  edited: edited === null ? null : scam(edited),
});

describe('itemChanged', () => {
  it('is true only when an edited verdict differs from the current one', () => {
    expect(itemChanged(item(false, true), ['scam'])).toBe(true);
    expect(itemChanged(item(false, false), ['scam'])).toBe(false);
    expect(itemChanged(item(false, null), ['scam'])).toBe(false);
  });

  it('ignores labels the run did not judge', () => {
    expect(itemChanged(item(false, true), ['poi'])).toBe(false);
  });
});

describe('runIsStale', () => {
  it('flags a run whose drafts changed after it was submitted, such as a save mid-run', () => {
    const before = JSON.stringify({ base: 'draft' });
    const afterSave = JSON.stringify({});
    expect(runIsStale(before, afterSave)).toBe(true);
    expect(runIsStale(before, before)).toBe(false);
    expect(runIsStale(null, afterSave)).toBe(false);
  });
});
