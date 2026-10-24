import { describe, expect, it } from 'vitest';
import {
  parseTextScanStep,
  parseTextScanSteps,
  segmentIndexOf,
  textScanStepsBySegment,
} from '~/server/services/text-scan/parse';

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

  it('accepts a csam verdict and rejects one without a detected flag', () => {
    const csam = { detected: true, reason: 'test' };
    expect(parseTextScanStep(step(JSON.stringify({ csam })), ['csam'])).toEqual({
      ok: true,
      output: { csam },
    });
    expect(
      parseTextScanStep(step(JSON.stringify({ csam: { reason: 'test' } })), ['csam'])
    ).toMatchObject({ ok: false, reason: 'malformed' });
  });
});

const segStep = (
  segment: number | undefined,
  parsed: unknown,
  opts: { name?: string; finishReason?: string; content?: string | null } = {}
) => ({
  $type: 'chatCompletion',
  ...(opts.name !== undefined ? { name: opts.name } : {}),
  ...(segment !== undefined ? { metadata: { segment } } : {}),
  output: {
    choices: [
      {
        message: { content: opts.content !== undefined ? opts.content : JSON.stringify(parsed) },
        finishReason: opts.finishReason ?? 'stop',
      },
    ],
    parsed,
  },
});
const verdict = (level: string) => ({ nsfw: { level, reason: `r-${level}` } });

describe('segmentIndexOf', () => {
  it('reads metadata.segment first, then the textScanN name', () => {
    expect(segmentIndexOf(segStep(2, {}, { name: 'textScan5' }))).toBe(2);
    expect(segmentIndexOf(segStep(undefined, {}, { name: 'textScan3' }))).toBe(3);
    expect(segmentIndexOf(segStep(undefined, {}, { name: 'textScan' }))).toBe(0);
    expect(segmentIndexOf(segStep(undefined, {}))).toBeUndefined();
    expect(segmentIndexOf({ $type: 'chatCompletion', metadata: { segment: -1 } })).toBeUndefined();
  });
});

describe('textScanStepsBySegment', () => {
  it('falls back to submission order and keeps the first step for a repeated index', () => {
    const a = segStep(undefined, verdict('none'));
    const b = segStep(0, verdict('x'));
    const map = textScanStepsBySegment([{ $type: 'other' }, a, b]);
    expect([...map.keys()]).toEqual([0]);
    expect(map.get(0)).toBe(a);
  });
});

describe('parseTextScanSteps', () => {
  it('parses steps out of order into segment order', () => {
    const result = parseTextScanSteps(
      [segStep(2, verdict('x')), segStep(0, verdict('none')), segStep(1, verdict('r'))],
      ['nsfw'],
      3
    );
    expect(result).toEqual({ ok: true, outputs: [verdict('none'), verdict('r'), verdict('x')] });
  });

  it('orders by step name when the orchestrator does not echo step metadata', () => {
    const result = parseTextScanSteps(
      [
        segStep(undefined, verdict('x'), { name: 'textScan1' }),
        segStep(undefined, verdict('none'), { name: 'textScan' }),
      ],
      ['nsfw'],
      2
    );
    expect(result).toEqual({ ok: true, outputs: [verdict('none'), verdict('x')] });
  });

  it('parses a pre-segmentation single step with no name or metadata', () => {
    const legacy = {
      $type: 'chatCompletion',
      output: {
        choices: [{ message: { content: '' }, finishReason: 'stop' }],
        parsed: verdict('r'),
      },
    };
    expect(parseTextScanSteps([legacy], ['nsfw'], 1)).toEqual({
      ok: true,
      outputs: [verdict('r')],
    });
  });

  it('fails a missing segment with its index', () => {
    expect(
      parseTextScanSteps([segStep(0, verdict('none')), segStep(2, verdict('none'))], ['nsfw'], 3)
    ).toEqual({
      ok: false,
      reason: 'missing_segment',
      segment: 1,
      outputs: [verdict('none'), verdict('none')],
    });
  });

  it('fails when two steps claim the same segment and one is therefore missing', () => {
    expect(
      parseTextScanSteps([segStep(0, verdict('none')), segStep(0, verdict('x'))], ['nsfw'], 2)
    ).toEqual({ ok: false, reason: 'missing_segment', segment: 1, outputs: [verdict('none')] });
  });

  it('fails more steps than were submitted', () => {
    expect(
      parseTextScanSteps([segStep(0, verdict('none')), segStep(1, verdict('none'))], ['nsfw'], 1)
    ).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it.each([
    ['empty', segStep(1, undefined, { content: '' })],
    ['refused', segStep(1, undefined, { finishReason: 'content_filter' })],
    ['truncated', segStep(1, undefined, { content: '{"nsfw":', finishReason: 'length' })],
    ['malformed', segStep(1, undefined, { content: 'not json' })],
    ['missing_label', segStep(1, { scam: { detected: false, reason: 'r' } })],
  ])('fails the whole scan when one segment is %s, naming the segment', (reason, bad) => {
    expect(parseTextScanSteps([segStep(0, verdict('none')), bad], ['nsfw'], 2)).toMatchObject({
      ok: false,
      reason,
      segment: 1,
    });
  });

  it('names the first failing segment and returns every segment that parsed, in order', () => {
    const bad = segStep(1, undefined, { content: 'not json' });
    const worse = segStep(3, undefined, { finishReason: 'content_filter' });
    expect(
      parseTextScanSteps(
        [segStep(2, verdict('r')), worse, bad, segStep(0, verdict('x'))],
        ['nsfw'],
        4
      )
    ).toEqual({
      ok: false,
      reason: 'malformed',
      segment: 1,
      outputs: [verdict('x'), verdict('r')],
    });
  });

  it('returns no outputs when the workflow has more steps than were submitted', () => {
    expect(
      parseTextScanSteps([segStep(0, verdict('x')), segStep(1, verdict('x'))], ['nsfw'], 1)
    ).toMatchObject({ ok: false, outputs: [] });
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'fails a bad expected count %s instead of passing nothing',
    (n) => {
      expect(parseTextScanSteps([segStep(0, verdict('none'))], ['nsfw'], n)).toMatchObject({
        ok: false,
        reason: 'malformed',
      });
      expect(parseTextScanSteps([], ['nsfw'], n)).toMatchObject({ ok: false, reason: 'malformed' });
    }
  );
});
