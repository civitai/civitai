import { describe, expect, it } from 'vitest';
import { parseTextScanStep } from '~/server/services/text-scan/parse';

const step = (content: string | null, opts: { parsed?: unknown; finishReason?: string } = {}) => ({
  $type: 'chatCompletion',
  output: {
    choices: [{ message: { content }, finishReason: opts.finishReason ?? 'stop' }],
    parsed: opts.parsed,
  },
});

const good = {
  nsfw: { level: 'r', reason: 'Describes nudity.' },
  poi: { detected: true, names: ['Jane Doe'], reason: 'Names a real actress.' },
};

describe('parseTextScanStep', () => {
  it('accepts a complete parsed output', () => {
    const result = parseTextScanStep(step(JSON.stringify(good), { parsed: good }), ['nsfw', 'poi']);
    expect(result).toEqual({ ok: true, output: good });
  });

  it('falls back to parsing content when parsed is absent', () => {
    const result = parseTextScanStep(step(JSON.stringify(good)), ['nsfw', 'poi']);
    expect(result.ok).toBe(true);
  });

  it('drops labels that were not requested', () => {
    const result = parseTextScanStep(step(JSON.stringify(good), { parsed: good }), ['nsfw']);
    expect(result).toEqual({ ok: true, output: { nsfw: good.nsfw } });
  });

  it.each([
    ['no step', undefined, 'empty'],
    ['empty content', step(''), 'empty'],
    ['whitespace content', step('   '), 'empty'],
    ['refusal prose', step("I'm sorry, but I can't help with that."), 'refused'],
    ['content filter', step('', { finishReason: 'content_filter' }), 'refused'],
    ['truncated json', step('{"nsfw":{"level":"r","rea', { finishReason: 'length' }), 'truncated'],
    ['prose', step('This text looks fine to me.'), 'malformed'],
    [
      'wrong level',
      step(JSON.stringify({ nsfw: { level: 'spicy', reason: 'x' }, poi: good.poi })),
      'malformed',
    ],
    ['missing reason', step(JSON.stringify({ nsfw: { level: 'r' }, poi: good.poi })), 'malformed'],
    ['array root', step('[1,2]'), 'malformed'],
    ['missing label', step(JSON.stringify({ nsfw: good.nsfw })), 'missing_label'],
  ])('returns Failed for %s', (_name, input, reason) => {
    const result = parseTextScanStep(input as any, ['nsfw', 'poi']);
    expect(result).toMatchObject({ ok: false, reason });
  });

  it('names the missing labels in detail', () => {
    const result = parseTextScanStep(step(JSON.stringify({ nsfw: good.nsfw })), ['nsfw', 'poi']);
    expect(result).toEqual({ ok: false, reason: 'missing_label', detail: 'poi' });
  });
});
