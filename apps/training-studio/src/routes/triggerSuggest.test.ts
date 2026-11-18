import { describe, expect, it } from 'vitest';
import { suggestTrigger, triggerForImport } from './triggerSuggest';

describe('suggestTrigger', () => {
  it('offers the first tag that leads at least 75% of the captions, in its most-used casing', () => {
    expect(
      suggestTrigger(['MyChar, solo', 'mychar, smile', 'mychar, outdoors', 'mychar, hat', '1girl'])
    ).toBe('mychar');
  });
  it('the threshold is three in four captioned files; uncaptioned ones are left to auto-label', () => {
    expect(suggestTrigger(['mychar, a', 'mychar, b', 'mychar, c', 'hat'])).toBe('mychar');
    expect(suggestTrigger(['mychar, a', 'mychar, b', 'hat'])).toBeNull();
    expect(suggestTrigger([...Array(5).fill('mychar, a'), 'hat', 'dress'])).toBeNull(); // 5 of 7
    expect(suggestTrigger(['mychar, smile', 'mychar, hat', 'mychar', '', ''])).toBe('mychar');
  });
  // The trainer matches the trigger as spelled, so folding these would prepend my_char to "my char" images.
  it('does not treat my_char and my char as one tag', () => {
    expect(suggestTrigger(['my_char, a', 'my_char, b', 'my char, c', 'my char, d'])).toBeNull();
  });
  it.each([
    '1girl',
    '2boys',
    '6+girls',
    '1other',
    'solo',
    'Solo',
    'multiple girls',
    'multiple boys',
    'no humans',
    'anime screencap',
    'anime_screencap',
    'anime screenshot',
    'male focus',
    'female focus',
    'looking at viewer',
    'simple background',
    'white background',
    'monochrome',
    'greyscale',
    'best quality',
  ])('never offers the generic lead tag %s', (tag) => {
    expect(suggestTrigger([`${tag}, smile`, `${tag}, hat`, tag])).toBeNull();
  });
  it('needs at least two captions to agree', () => {
    expect(suggestTrigger(['mychar, smile'])).toBeNull();
    expect(suggestTrigger(['mychar, smile', ''])).toBeNull();
  });
});

describe('triggerForImport', () => {
  const captions = ['mychar, a', 'mychar, b'];
  it('fills an empty trigger field after a tag-mode import', () => {
    expect(triggerForImport({ labelMode: 'tag', trigger: ' ', mayFill: true, captions })).toBe(
      'mychar'
    );
  });
  it('never overwrites a trigger the user typed, nor refills one they cleared during the same import', () => {
    expect(
      triggerForImport({ labelMode: 'tag', trigger: 'other', mayFill: true, captions })
    ).toBeNull();
    expect(
      triggerForImport({ labelMode: 'tag', trigger: '', mayFill: false, captions })
    ).toBeNull();
  });
  it('leaves caption mode alone: a sentence has no first tag', () => {
    expect(
      triggerForImport({ labelMode: 'caption', trigger: '', mayFill: true, captions })
    ).toBeNull();
  });
});
