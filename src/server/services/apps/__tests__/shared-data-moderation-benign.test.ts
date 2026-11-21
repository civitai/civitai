import { describe, expect, it, vi } from 'vitest';
import {
  nsfwPromptWords,
  nsfwWordsPaddle,
  nsfwWordsSoft,
  youngWords,
} from '@civitai/mod-utils/prompt-audit/lists';
import { auditPromptEnriched, includesInappropriate, includesNsfw } from '~/utils/metadata/audit';

const strip = vi.hoisted(() => ({ phrase: '' }));
vi.mock('~/server/services/blocklist.service', () => ({
  findBlockedUserContent: async () => [],
  stripBenignPhrases: async (text: string) =>
    strip.phrase ? text.split(strip.phrase).join(' ').trim() : text,
}));

import { classifySharedTexts } from '~/server/services/apps/shared-data-moderation';

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

const leaf = (raw: string) => ({ raw, path: 'x', segments: ['x'], kind: 'value' as const });
const auditLabels = async (raw: string) =>
  (await classifySharedTexts([leaf(raw)])).map((hit) => hit.label);

describe('the shared-data audit with benign phrases', () => {
  const { n, y } = pickPair();

  it('flags the pair when nothing is stripped', async () => {
    strip.phrase = '';
    expect(await auditLabels(`${n} ${y}`)).toContain('inappropriate_minor');
  });

  it('decides which checks run from the text as written', async () => {
    strip.phrase = n;
    expect(await auditLabels(`${n} ${y}`)).toContain('inappropriate_minor');
  });

  it('does not flag the second word alone as the pair', async () => {
    strip.phrase = '';
    expect(await auditLabels(y)).not.toContain('inappropriate_minor');
  });
});

describe('auditPromptEnriched without the nsfw option', () => {
  const { n, y } = pickPair();
  const category = (text: string, nsfw?: boolean) =>
    auditPromptEnriched(text, undefined, undefined, nsfw === undefined ? undefined : { nsfw })
      .triggers[0]?.category;

  it('flags the pair', () => {
    expect(category(`${n} ${y}`)).toBe('inappropriate_minor');
  });

  it('leaves the second word alone unflagged, as before the option existed', () => {
    expect(category(y)).not.toBe('inappropriate_minor');
  });

  it('flags the second word alone when the caller passes it', () => {
    expect(category(y, true)).toBe('inappropriate_minor');
  });
});
