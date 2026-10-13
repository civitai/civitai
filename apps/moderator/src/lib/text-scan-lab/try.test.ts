import { describe, expect, it } from 'vitest';
import { parseCheckInput } from './input';
import { editedPromptKeys, judgeCandidates, sourceTypeOf } from './try';
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
    expect(judgeCandidates(null, ['label:modelRules'])).toEqual(['ModelRules']);
  });

  it('lets a model be judged by its rules scan when the rules prompt is edited', () => {
    expect(judgeCandidates('Model', ['label:modelRules'])).toEqual(['ModelRules']);
    expect(judgeCandidates('Model', ['label:nsfw'])).toEqual(['Model']);
    expect(judgeCandidates('Model', [])).toEqual(['Model', 'ModelRules']);
  });

  it('keeps a link type that uses none of the edited labels rather than offering nothing', () => {
    expect(judgeCandidates('Article', ['label:scam'])).toEqual(['Article']);
  });
});

describe('editedPromptKeys', () => {
  it('counts rule edits as an edit of the Model rules prompt', () => {
    const rule = { id: -1, subject: 'X', description: '', aliases: [], enabled: true };
    expect(editedPromptKeys({ base: 'B' }, [])).toEqual(['base']);
    expect(editedPromptKeys({}, [rule])).toEqual(['label:modelRules']);
    expect(editedPromptKeys({ 'label:modelRules': 'P' }, [rule])).toEqual(['label:modelRules']);
  });
});
