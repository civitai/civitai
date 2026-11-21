import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { blockedWords } from '@civitai/mod-utils/profanity/lists';
import { cleanWord, isUsableBlockedEntry } from '@civitai/mod-utils/profanity/word-rules';
import { getProfanityFilter } from '~/libs/profanity-simple';
import { setProfanityListReaderForTests } from '~/server/services/profanity-list.service';
import { auditTrainingTriggerWord } from '~/utils/metadata/training-trigger-word';
import { TokenScope } from '~/shared/constants/token-scope.constants';

import { trainingRouter } from '../training.router';

// A managed list holding one synthetic token, on no real list.
const TOKEN = 'zqvoxtrainertoken';

const user = {
  id: 2,
  isModerator: false,
  tier: 'free',
  username: 'member',
  onboarding: 0x1f,
  emailVerified: new Date('2024-01-01'),
  muted: false,
  bannedAt: null,
  deletedAt: null,
};

function audit(triggerWord: string, isGreen: boolean) {
  return trainingRouter
    .createCaller({
      acceptableOrigin: true,
      user,
      apiKeyId: null,
      tokenScope: TokenScope.Full,
      req: { headers: {}, socket: { remoteAddress: '10.0.0.1' } } as never,
      res: { setHeader: () => undefined } as never,
      cache: { edgeTTL: 0 },
      features: { isGreen } as never,
      track: undefined,
    } as never)
    .auditTriggerWord({ triggerWord });
}

beforeEach(() => {
  setProfanityListReaderForTests({
    read: async () => ({ blocked: [TOKEN], allowed: null, source: 'managed' }),
  });
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

describe('training.auditTriggerWord', () => {
  it('warns on civitai.com, naming the word as typed', async () => {
    expect(await audit(`my${TOKEN}style`, true)).toEqual({
      severity: 'soft',
      offendingWords: [`my${TOKEN}style`],
    });
  });

  it('runs no profanity check off civitai.com', async () => {
    expect(await audit(`my${TOKEN}style`, false)).toEqual({
      severity: 'clean',
      offendingWords: [],
    });
  });

  it('never names the list entry behind a leetspeak match, only what was typed', async () => {
    const typed = TOKEN.replace('o', '0');
    const result = await audit(typed, true);
    expect(result.severity).toBe('soft');
    expect(result.offendingWords).toEqual([typed]);
  });
});

describe("training.auditTriggerWord, the trainer's only check", () => {
  // The browser checked with the shipped list before; with the flag off the server's answer must
  // be the same one. Entries are named by position only: CI logs are public.
  it('flag off: answers what the browser answered with the shipped list', async () => {
    setProfanityListReaderForTests({
      read: async () => ({ blocked: null, allowed: null, source: 'shipped' }),
    });
    const words = blockedWords
      .filter(isUsableBlockedEntry)
      .slice(0, 8)
      .map((word) => `my${cleanWord(word).replace(/\|/g, '')}style`);
    const before = words.map((word) => auditTrainingTriggerWord(word, getProfanityFilter()));
    expect(before.filter((result) => result.severity !== 'clean').length).toBeGreaterThan(0);
    const differing: string[] = [];
    for (const [index, word] of words.entries()) {
      const { severity } = await audit(word, true);
      if (severity !== before[index].severity) differing.push(`shipped entry #${index}`);
    }
    expect(differing).toEqual([]);
  });
});
