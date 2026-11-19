import { describe, expect, it } from 'vitest';
import {
  nsfwPromptWords,
  nsfwWordsPaddle,
  nsfwWordsSoft,
  youngWords,
} from '@civitai/mod-utils/prompt-audit/lists';
import { getSearchRefusal } from '~/components/Search/search-refusal';
import { includesInappropriate, includesNsfw } from '~/utils/metadata/audit';

/** Two words the audit flags together but not apart. */
function pickPair() {
  for (const n of [...nsfwPromptWords, ...nsfwWordsSoft, ...nsfwWordsPaddle]) {
    if (!/^[a-z]+$/.test(n) || !includesNsfw(n)) continue;
    for (const y of youngWords.nouns) {
      if (!/^[a-z]+$/.test(y) || includesInappropriate({ prompt: y })) continue;
      if (includesInappropriate({ prompt: `${n} ${y}` }) === 'minor') return { n, y };
    }
  }
  throw new Error('no word pair found');
}

describe('getSearchRefusal with benign phrases', () => {
  const { n, y } = pickPair();
  const refusal = (text: string, auditedText = text) =>
    getSearchRefusal({ text, auditedText, disablePoi: false });

  it('refuses the pair when nothing is stripped', () => {
    expect(refusal(`${n} ${y}`)).toBe('illegal');
  });

  it('decides which checks run from the search as typed', () => {
    expect(refusal(`${n} ${y}`, y)).toBe('illegal');
  });

  it('lets the second word alone run', () => {
    expect(refusal(y)).toBeUndefined();
  });
});
