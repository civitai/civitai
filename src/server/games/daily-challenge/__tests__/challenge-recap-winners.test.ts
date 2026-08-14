import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Openrouter from '~/server/services/ai/openrouter';
import type { JudgingConfig } from '~/server/games/daily-challenge/daily-challenge.utils';

// 🔴 The recap named the wrong people. `generateWinners` writes the prose AND picks winners; when
// an engine supplies the places the caller discards the picks, but nothing reconciled the PROSE
// with what was discarded — so the model chose three names of its own from the shortlist and the
// published recap celebrated entrants who had not placed. One live run congratulated ranks 5, 4
// and 3 by name and never mentioned the winner or the runner-up, rendered beside the real podium.
// (Entrant names below are placeholders — this repo is public and those were real accounts.)
//
// These assertions are about the PROMPT, because that is the only layer where "the model was told
// who won" can be checked without a live LLM.

const { getJsonCompletionWithUsage } = vi.hoisted(() => ({
  getJsonCompletionWithUsage: vi.fn(),
}));

vi.mock('~/server/services/ai/openrouter', async (importOriginal) => ({
  ...(await importOriginal<typeof Openrouter>()),
  openrouter: { getJsonCompletionWithUsage },
}));

vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn() }));
vi.mock('~/server/services/challenge-category.service', () => ({
  resolveRubricBlock: vi.fn().mockResolvedValue(''),
}));

const { generateWinners } = await import('~/server/games/daily-challenge/generative-content');

const config = {
  judgeId: 1,
  userId: 2,
  sourceCollectionId: null,
  reviewTemplate: null,
  prompts: {
    systemMessage: 'You are the judge.',
    collection: 'c',
    article: 'a',
    content: 'c',
    review: 'r',
    winner: 'winner prompt',
  },
} as JudgingConfig;

const entries = [
  { creatorId: 1, creator: 'entrant_a', summary: 's1', score: { theme: 9 } },
  { creatorId: 2, creator: 'entrant_b', summary: 's2', score: { theme: 8 } },
  { creatorId: 3, creator: 'entrant_c', summary: 's3', score: { theme: 8 } },
  { creatorId: 4, creator: 'entrant_d', summary: 's4', score: { theme: 7 } },
  { creatorId: 5, creator: 'entrant_e', summary: 's5', score: { theme: 7 } },
] as never;

const decidedWinners = [
  { creatorId: 1, creator: 'entrant_a', place: 1, reason: 'won the round-robin' },
  { creatorId: 2, creator: 'entrant_b', place: 2, reason: 'second on win rate' },
];

function promptText() {
  const messages = getJsonCompletionWithUsage.mock.calls[0][0].messages;
  return messages
    .map((message: { content: unknown }) =>
      typeof message.content === 'string'
        ? message.content
        : (message.content as { text?: string }[]).map((part) => part.text ?? '').join('\n')
    )
    .join('\n');
}

beforeEach(() => {
  vi.clearAllMocks();
  getJsonCompletionWithUsage.mockResolvedValue({
    content: {
      // What the model returned when it was picking for itself — the discarded set.
      winners: [
        { creatorId: 5, creator: 'entrant_e', reason: 'dreamy sunset beach' },
        { creatorId: 4, creator: 'entrant_d', reason: 'quirky robot humor' },
      ],
      process: 'how I judged',
      outcome: 'what happened',
    },
    usage: { promptTokens: 1, completionTokens: 1 },
  });
});

describe('generateWinners — when an engine already decided the places', () => {
  it('tells the model who won instead of asking it to choose', async () => {
    await generateWinners({ theme: 'Neon', entries, config, decidedWinners });

    const prompt = promptText();
    expect(prompt).toContain('ALREADY DECIDED');
    expect(prompt).toContain('entrant_a');
    expect(prompt).toContain('entrant_b');
    expect(prompt).not.toContain('Select exactly 3 different winners');
  });

  it('returns the decided places, never the model’s own picks', async () => {
    const result = await generateWinners({ theme: 'Neon', entries, config, decidedWinners });

    expect(result.winners.map((winner) => winner.creator)).toEqual(['entrant_a', 'entrant_b']);
    // The ranks the live recap wrongly celebrated: 5th and 4th.
    expect(result.winners.map((winner) => winner.creator)).not.toContain('entrant_e');
    expect(result.winners.map((winner) => winner.creator)).not.toContain('entrant_d');
  });

  it('still returns the prose, which is the only reason the call is made at all', async () => {
    const result = await generateWinners({ theme: 'Neon', entries, config, decidedWinners });

    expect(result.process).toBe('how I judged');
    expect(result.outcome).toBe('what happened');
  });

  it('does not crash when the model omits the winners key it was never asked for', async () => {
    getJsonCompletionWithUsage.mockResolvedValue({
      content: { process: 'p', outcome: 'o' },
      usage: { promptTokens: 1, completionTokens: 1 },
    });

    const result = await generateWinners({ theme: 'Neon', entries, config, decidedWinners });

    expect(result.winners).toHaveLength(2);
  });
});

describe('generateWinners — with no engine opinion', () => {
  it('asks the model to pick, exactly as before', async () => {
    const result = await generateWinners({ theme: 'Neon', entries, config });

    const prompt = promptText();
    expect(prompt).toContain('Select exactly 3 different winners');
    expect(prompt).not.toContain('ALREADY DECIDED');
    expect(result.winners.map((winner) => winner.creatorId)).toEqual([5, 4]);
  });

  it('treats an empty decided list as no opinion rather than as an empty podium', async () => {
    await generateWinners({ theme: 'Neon', entries, config, decidedWinners: [] });

    expect(promptText()).toContain('Select exactly 3 different winners');
  });
});
