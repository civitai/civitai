import { describe, expect, it, vi } from 'vitest';
import {
  nsfwPromptWords,
  nsfwWordsPaddle,
  nsfwWordsSoft,
  youngWords,
} from '@civitai/mod-utils/prompt-audit/lists';
import type * as BlocklistService from '~/server/services/blocklist.service';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { includesInappropriate, includesNsfw } from '~/utils/metadata/audit';

const strip = vi.hoisted(() => ({ phrase: '' }));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  // A benign phrase that happens to contain a word from the nsfw list.
  stripBenignPhrases: async (text: string) =>
    strip.phrase ? text.split(strip.phrase).join(' ').trim() : text,
}));
vi.mock('~/server/services/search-query-rules', () => ({ matchesQueryRule: async () => false }));

const { semanticQueryRefusal } = await import('~/server/services/semantic-query-guard');

/** A word only the nsfw list flags, and a word the age check flags only alongside one. */
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

describe('semanticQueryRefusal with benign phrases', () => {
  const { n, y } = pickPair();
  const opts = { browsingLevel: sfwBrowsingLevelsFlag, disablePoi: false, isModerator: false };

  it('flags the pair when nothing is stripped', async () => {
    strip.phrase = '';
    expect(await semanticQueryRefusal(`${n} ${y}`, opts)).toBe('minor');
  });

  it('still flags it when a benign phrase strips the word that opened the check', async () => {
    strip.phrase = n;
    expect(await semanticQueryRefusal(`${n} ${y}`, opts)).toBe('minor');
  });

  it('passes the second word alone', async () => {
    strip.phrase = '';
    expect(await semanticQueryRefusal(y, opts)).toBe(false);
  });
});
