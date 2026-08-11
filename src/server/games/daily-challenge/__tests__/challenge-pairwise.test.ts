import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as GenerativeContent from '~/server/games/daily-challenge/generative-content';
import {
  buildComparisonPrompt,
  comparePair,
  type ComparisonImage,
} from '~/server/games/daily-challenge/challenge-pairwise';
import {
  JUDGE_ROUTES,
  PERMISSIVE_JUDGE,
} from '~/server/games/daily-challenge/challenge-judge-routes';
import { getCompletionWithUsage } from '~/server/games/daily-challenge/generative-content';
import type { JudgingCategory } from '~/server/games/daily-challenge/daily-challenge-scoring';

vi.mock('~/server/games/daily-challenge/generative-content', async (importOriginal) => ({
  ...(await importOriginal<typeof GenerativeContent>()),
  getCompletionWithUsage: vi.fn(),
}));

const completion = vi.mocked(getCompletionWithUsage);

const CATEGORIES: JudgingCategory[] = [
  { key: 'theme', label: 'Theme', weight: 70 },
  { key: 'creativity', label: 'Creativity', weight: 15 },
  { key: 'aesthetic', label: 'Aesthetic', weight: 15 },
];

const sfw = (imageId: number): ComparisonImage => ({
  imageId,
  url: `uuid-${imageId}`,
  nsfwLevel: 1,
});
const adult = (imageId: number): ComparisonImage => ({
  imageId,
  url: `uuid-${imageId}`,
  nsfwLevel: 8,
});

function verdict(body: Record<string, unknown>) {
  return {
    content: body,
    usage: { promptTokens: 1000, completionTokens: 100 },
  } as Awaited<ReturnType<typeof getCompletionWithUsage>>;
}

/** The image uuids, in the order they were seated in the user message. */
function seatedUuids(call: number): string[] {
  const messages = completion.mock.calls[call][1];
  const content = messages[1].content;
  if (typeof content === 'string') throw new Error('expected structured content');
  return content
    .filter(
      (item): item is { type: 'image_url'; image_url: { url: string } } => item.type === 'image_url'
    )
    .map((item) => item.image_url.url);
}

const systemText = (call: number) => {
  const content = completion.mock.calls[call][1][0].content;
  return typeof content === 'string'
    ? content
    : content.map((c) => ('text' in c ? c.text : '')).join('');
};

beforeEach(() => {
  completion.mockReset();
});

describe('comparePair seating', () => {
  it('alternates which entry sits second as the step advances', async () => {
    completion.mockResolvedValue(verdict({ winner: '1', margin: 'clear', perCategory: {} }));

    await comparePair({
      systemPrompt: 'system',
      categories: CATEGORIES,
      challenger: sfw(1),
      opponent: sfw(2),
      step: 0,
    });
    await comparePair({
      systemPrompt: 'system',
      categories: CATEGORIES,
      challenger: sfw(1),
      opponent: sfw(2),
      step: 1,
    });

    // Whichever image sits second won 127 of 210 comparisons in the round-robin, so the seat has
    // to move: a fixed seat bakes that bias into every rank.
    expect(seatedUuids(0)[0]).toContain('uuid-1');
    expect(seatedUuids(1)[0]).toContain('uuid-2');
  });

  it('reports the winner as an imageId, not a seat, so an alternated seat cannot invert it', async () => {
    completion.mockResolvedValue(verdict({ winner: '1', margin: 'clear', perCategory: {} }));

    const even = await comparePair({
      systemPrompt: 'system',
      categories: CATEGORIES,
      challenger: sfw(1),
      opponent: sfw(2),
      step: 0,
    });
    const odd = await comparePair({
      systemPrompt: 'system',
      categories: CATEGORIES,
      challenger: sfw(1),
      opponent: sfw(2),
      step: 1,
    });

    expect(even.winnerImageId).toBe(1);
    expect(even.firstSeatImageId).toBe(1);
    expect(odd.winnerImageId).toBe(2);
    expect(odd.firstSeatImageId).toBe(2);
  });

  it('returns a tie as null rather than picking a side', async () => {
    completion.mockResolvedValue(verdict({ winner: 'tie', margin: 'narrow', perCategory: {} }));
    const result = await comparePair({
      systemPrompt: 'system',
      categories: CATEGORIES,
      challenger: sfw(1),
      opponent: sfw(2),
      step: 0,
    });
    expect(result.winnerImageId).toBeNull();
  });
});

describe('comparePair routing and refusals', () => {
  it('routes by the HIGHER nsfwLevel of the pair, never per entry', async () => {
    completion.mockResolvedValue(verdict({ winner: '1', perCategory: {} }));

    await comparePair({
      systemPrompt: 'system',
      categories: CATEGORIES,
      challenger: sfw(1),
      opponent: adult(2),
      step: 0,
    });

    expect(completion.mock.calls[0][0]).toBe(PERMISSIVE_JUDGE);
  });

  it('falls back to the permissive judge on a refusal and KEEPS the entry', async () => {
    completion
      .mockRejectedValueOnce(new Error('HTTP 400: {"error":"data_inspection_failed"}'))
      .mockResolvedValueOnce(verdict({ winner: '2', margin: 'clear', perCategory: {} }));

    const result = await comparePair({
      systemPrompt: 'system',
      categories: CATEGORIES,
      challenger: sfw(1),
      opponent: sfw(2),
      step: 0,
    });

    // Unhandled, this refusal silently deleted 54 of 284 entries from a live run and still
    // printed a clean ladder. The comparison must come back answered, not throw.
    expect(completion.mock.calls[0][0]).toBe(JUDGE_ROUTES[0].model);
    expect(completion.mock.calls[1][0]).toBe(PERMISSIVE_JUDGE);
    expect(result.winnerImageId).toBe(2);
    expect(result.rerouted).toBe(true);
    expect(result.model).toBe(PERMISSIVE_JUDGE);
  });

  it('does not swallow a refusal from the permissive judge itself', async () => {
    completion.mockRejectedValue(new Error('data_inspection_failed'));
    await expect(
      comparePair({
        systemPrompt: 'system',
        categories: CATEGORIES,
        challenger: adult(1),
        opponent: adult(2),
        step: 0,
      })
    ).rejects.toThrow(/data_inspection_failed/);
    expect(completion).toHaveBeenCalledTimes(1);
  });

  it('does not reroute an ordinary failure — that would hide a broken route behind a bigger bill', async () => {
    completion.mockRejectedValue(new Error('HTTP 429: rate limited'));
    await expect(
      comparePair({
        systemPrompt: 'system',
        categories: CATEGORIES,
        challenger: sfw(1),
        opponent: sfw(2),
        step: 0,
      })
    ).rejects.toThrow(/rate limited/);
    expect(completion).toHaveBeenCalledTimes(1);
  });

  it('charges the model that actually answered', async () => {
    completion.mockResolvedValue(verdict({ winner: '1', perCategory: {} }));
    const cheap = await comparePair({
      systemPrompt: 'system',
      categories: CATEGORIES,
      challenger: sfw(1),
      opponent: sfw(2),
      step: 0,
    });
    const permissive = await comparePair({
      systemPrompt: 'system',
      categories: CATEGORIES,
      challenger: adult(1),
      opponent: adult(2),
      step: 0,
    });

    expect(cheap.buzzCost).toBeGreaterThan(0);
    expect(permissive.buzzCost).toBeGreaterThan(cheap.buzzCost);
  });
});

describe('comparePair per-category verdicts', () => {
  it('maps every challenge category back to an imageId, tolerating label drift', async () => {
    completion.mockResolvedValue(
      verdict({
        winner: '1',
        perCategory: { theme: '2', Creativity: '1', AESTHETIC: 'tie' },
      })
    );

    const result = await comparePair({
      systemPrompt: 'system',
      categories: CATEGORIES,
      challenger: sfw(1),
      opponent: sfw(2),
      step: 0,
    });

    expect(result.perCategory).toEqual({ Theme: 2, Creativity: 1, Aesthetic: null });
  });

  it('reports a category the judge omitted as a tie rather than dropping the key', async () => {
    completion.mockResolvedValue(verdict({ winner: '1', perCategory: { Theme: '1' } }));
    const result = await comparePair({
      systemPrompt: 'system',
      categories: CATEGORIES,
      challenger: sfw(1),
      opponent: sfw(2),
      step: 0,
    });
    expect(Object.keys(result.perCategory)).toEqual(['Theme', 'Creativity', 'Aesthetic']);
    expect(result.perCategory.Creativity).toBeNull();
  });
});

describe('buildComparisonPrompt', () => {
  it("uses the challenge's own categories and weights, not the fixed daily split", () => {
    const prompt = buildComparisonPrompt({
      theme: 'Neon Dreams',
      categories: CATEGORIES,
      criteriaByKey: { theme: 'fits the theme', creativity: 'novel idea' },
    });

    expect(prompt).toContain('Theme (70% of the decision): fits the theme');
    expect(prompt).toContain('Creativity (15% of the decision): novel idea');
    expect(prompt).toContain('Theme is 70% of the decision.');
    expect(prompt).not.toContain('Wittiness');
    expect(prompt).not.toContain('Humor');
  });

  it('asks for a verdict on every category the challenge defines', () => {
    const prompt = buildComparisonPrompt({ theme: 'x', categories: CATEGORIES });
    for (const category of CATEGORIES) expect(prompt).toContain(`"${category.label}": "1" | "2"`);
  });

  it('covers text that asserts a score, not only text that asks for one', () => {
    // Prod's absolute clause fires only on text *requesting* a high score, and a real entry walked
    // past it by asserting a score cap in the judge's own voice.
    const prompt = buildComparisonPrompt({ theme: 'x', categories: CATEGORIES });
    expect(prompt).toMatch(/addresses you/);
    expect(prompt).toMatch(/names or impersonates the judge/);
    expect(prompt).toMatch(/what a score, cap, rank, or placement should be/);
  });
});

describe('comparison messages', () => {
  it('sends both images with the challenge prompt as the system message', async () => {
    completion.mockResolvedValue(verdict({ winner: '1', perCategory: {} }));
    await comparePair({
      systemPrompt: 'judge these two',
      categories: CATEGORIES,
      challenger: sfw(11),
      opponent: sfw(22),
      step: 0,
    });

    expect(systemText(0)).toBe('judge these two');
    expect(seatedUuids(0)).toHaveLength(2);
    expect(seatedUuids(0)[0]).toContain('uuid-11');
    expect(seatedUuids(0)[1]).toContain('uuid-22');
  });
});
