import { describe, expect, it } from 'vitest';
import { suggestTrigger } from './triggerSuggest';

describe('suggestTrigger', () => {
  it('offers the first tag that leads at least 75% of the captions, in its most-used casing', () => {
    expect(
      suggestTrigger([
        'mychar, 1girl, smile',
        'MyChar, solo',
        'mychar, outdoors',
        'mychar, hat',
        '1girl, dress',
      ])
    ).toBe('mychar');
  });
  it('offers nothing below 75% of the captioned files; uncaptioned ones are left to auto-label', () => {
    expect(suggestTrigger(['mychar, smile', 'mychar, hat', '1girl', 'solo, hat'])).toBeNull();
    expect(suggestTrigger(['mychar, smile', 'mychar, hat', 'mychar', '', ''])).toBe('mychar');
  });
  it('never offers a generic lead tag such as 1girl, solo or anime screencap', () => {
    expect(suggestTrigger(['1girl, smile', '1girl, hat', '1girl'])).toBeNull();
    expect(suggestTrigger(['6+girls, smile', '6+girls'])).toBeNull();
    expect(suggestTrigger(['solo, smile', 'Solo, hat'])).toBeNull();
    expect(suggestTrigger(['anime_screencap, smile', 'anime screencap'])).toBeNull();
    expect(suggestTrigger(['anime screenshot, a', 'anime screenshot, b'])).toBeNull();
  });
  it('needs at least two captions to agree', () => {
    expect(suggestTrigger(['mychar, smile'])).toBeNull();
    expect(suggestTrigger(['mychar, smile', ''])).toBeNull();
  });
});
