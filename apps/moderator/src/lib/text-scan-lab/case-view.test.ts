import { describe, expect, it } from 'vitest';
import { casePreview, caseSourceHref } from './case-view';

describe('casePreview', () => {
  it('joins field texts without headings, whitespace collapsed', () => {
    expect(
      casePreview([
        { heading: 'Name', text: '  Cool\nmodel ' },
        { heading: 'Description', text: 'A  thing' },
      ])
    ).toBe('Cool model · A thing');
  });

  it('cuts a long text with an ellipsis', () => {
    expect(casePreview([{ heading: 'Name', text: 'abcdefghij' }], 6)).toBe('abcde…');
  });

  it('is null for a wiped case', () => {
    expect(casePreview(null)).toBeNull();
  });
});

describe('caseSourceHref', () => {
  it('links an entity, an account and nothing for free text', () => {
    expect(caseSourceHref('https://civitai.com', 'Model', 5)).toBe('https://civitai.com/models/5');
    expect(caseSourceHref('https://civitai.com', 'UserProfile', 7)).toContain('7');
    expect(caseSourceHref('https://civitai.com', 'Model', null)).toBeNull();
  });
});
