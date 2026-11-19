import { describe, expect, it } from 'vitest';
import { buildTagExcluder } from '$lib/autolabel-exclude';
import { labelString, mergeAutoLabel } from './trainingFlow';

const none = () => false;
const never = (...tags: string[]) =>
  buildTagExcluder({
    never: tags,
    categories: null,
    excludeCharacter: false,
    excludeSource: false,
  });
const tagged = { tags: ['1girl', 'solo'], caption: '' };
const captioned = { tags: [], caption: 'A woman stands in a field.' };

describe('mergeAutoLabel — caption format (the label is free text)', () => {
  it('appends a caption after existing tags-as-text, so the .txt holds both', () => {
    const img = { tags: [], caption: '1girl, solo' };
    const out = mergeAutoLabel(img, { caption: 'A woman stands.' }, 'caption', 'after', none);
    expect(labelString({ ...img, ...out } as never, 'caption')).toBe(
      '1girl, solo\nA woman stands.'
    );
  });

  it('puts the new text first for "before"', () => {
    const out = mergeAutoLabel(captioned, { tags: ['1girl', 'solo'] }, 'caption', 'before', none);
    expect(out.caption).toBe('1girl, solo\nA woman stands in a field.');
  });

  it('joins tagger output into the caption text, honouring the exclude list', () => {
    const out = mergeAutoLabel(
      captioned,
      { tags: ['1girl', 'watermark', 'solo'] },
      'caption',
      'after',
      never('watermark')
    );
    expect(out.caption).toBe('A woman stands in a field.\n1girl, solo');
  });

  it('does not append text the label already holds verbatim (a retry)', () => {
    const img = { tags: [], caption: '1girl, solo\nA woman stands.' };
    const out = mergeAutoLabel(img, { caption: 'A woman stands.' }, 'caption', 'after', none);
    expect(out.caption).toBe('1girl, solo\nA woman stands.');
  });

  it('appends a result that is only part of an existing line', () => {
    const img = { tags: [], caption: 'a woman stands in a field' };
    const out = mergeAutoLabel(img, { caption: 'a woman' }, 'caption', 'after', none);
    expect(out.caption).toBe('a woman stands in a field\na woman');
  });

  it('keeps the label when the result is empty', () => {
    expect(mergeAutoLabel(captioned, { caption: '  ' }, 'caption', 'after', none).caption).toBe(
      captioned.caption
    );
  });

  it('replaces the caption with tagger output joined as text', () => {
    const out = mergeAutoLabel(captioned, { tags: ['1girl', 'solo'] }, 'caption', 'replace', none);
    expect(out.caption).toBe('1girl, solo');
  });

  it('replace overwrites', () => {
    const out = mergeAutoLabel(captioned, { caption: 'New.' }, 'caption', 'replace', none);
    expect(out.caption).toBe('New.');
  });

  it('fills an empty label without a separator', () => {
    const out = mergeAutoLabel(
      { tags: [], caption: '' },
      { caption: 'New.' },
      'caption',
      'after',
      none
    );
    expect(out.caption).toBe('New.');
  });
});

describe('mergeAutoLabel — tag format (the label is tag chips)', () => {
  it('appends new tags after existing ones, deduped', () => {
    const out = mergeAutoLabel(tagged, { tags: ['solo', 'smile'] }, 'tag', 'after', none);
    expect(out.tags).toEqual(['1girl', 'solo', 'smile']);
  });

  it('puts new tags first for "before", deduped', () => {
    const out = mergeAutoLabel(tagged, { tags: ['smile', 'solo'] }, 'tag', 'before', none);
    expect(out.tags).toEqual(['smile', 'solo', '1girl']);
  });

  it('appends a caption to existing tags so the trained text holds both', () => {
    const out = mergeAutoLabel(tagged, { caption: 'A woman, smiling.' }, 'tag', 'after', none);
    expect(labelString({ ...tagged, ...out } as never, 'tag')).toBe(
      '1girl, solo, A woman, smiling.'
    );
  });

  it('replace overwrites, and the exclude list still applies', () => {
    const out = mergeAutoLabel(
      tagged,
      { tags: ['smile', 'Watermark'] },
      'tag',
      'replace',
      never('watermark')
    );
    expect(out.tags).toEqual(['smile']);
  });

  it('keeps the existing label when the result is empty', () => {
    expect(mergeAutoLabel(tagged, { tags: [] }, 'tag', 'replace', none).tags).toEqual([
      '1girl',
      'solo',
    ]);
  });
});
