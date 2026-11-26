import { describe, expect, it } from 'vitest';
import { matureLockReasonSentence } from '~/shared/constants/mature-lock-reason.constants';

const sentence = (fields: ('name' | 'description')[]) =>
  matureLockReasonSentence({ fields, category: 'mature-language' });

describe('matureLockReasonSentence', () => {
  it('names only the field that matched', () => {
    expect(sentence(['name'])).toMatch(/\bname\b/);
    expect(sentence(['name'])).not.toMatch(/description/);
    expect(sentence(['description'])).toMatch(/description/);
    expect(sentence(['description'])).not.toMatch(/\bname\b/);
  });

  it('names both when both matched', () => {
    expect(sentence(['description', 'name'])).toMatch(/name and description/);
  });
});
