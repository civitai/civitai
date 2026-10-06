import { describe, expect, it } from 'vitest';
import { composeUserMessage } from '../text-scan-lab/compose';
import {
  InvalidExpectedError,
  expectedChips,
  expectedFromOutput,
  parseExpected,
} from '../text-scan-lab/expected';

describe('expectedFromOutput', () => {
  it('turns the nsfw level into a one-level range and each flag into its detected verdict', () => {
    const output = {
      nsfw: { level: 'r', reason: 'x' },
      poi: { detected: true, names: ['someone'], reason: 'y' },
      minor: { detected: false, reason: 'z' },
    };
    expect(expectedFromOutput(output, ['nsfw', 'poi', 'minor'])).toEqual({
      nsfw: { min: 'r', max: 'r' },
      poi: true,
      minor: false,
    });
  });

  it('only covers the labels asked for', () => {
    const output = { nsfw: { level: 'x' }, scam: { detected: true } };
    expect(expectedFromOutput(output, ['scam'])).toEqual({ scam: true });
  });

  it('leaves out a label the output has no usable verdict for', () => {
    expect(
      expectedFromOutput({ nsfw: { level: 'extreme' }, poi: { reason: 'no verdict' } }, [
        'nsfw',
        'poi',
      ])
    ).toEqual({});
    expect(expectedFromOutput(null, ['nsfw'])).toEqual({});
  });
});

describe('parseExpected', () => {
  it('accepts a range and flags', () => {
    expect(parseExpected({ nsfw: { min: 'pg13', max: 'x' }, scam: false })).toEqual({
      nsfw: { min: 'pg13', max: 'x' },
      scam: false,
    });
    expect(parseExpected({})).toEqual({});
  });

  it('rejects min above max', () => {
    expect(() => parseExpected({ nsfw: { min: 'x', max: 'pg13' } })).toThrow(InvalidExpectedError);
    expect(() => parseExpected({ nsfw: { min: 'x', max: 'pg13' } })).toThrow(/min/);
  });

  it('rejects an unknown level name', () => {
    expect(() => parseExpected({ nsfw: { min: 'pg', max: 'r' } })).toThrow(/pg/);
  });

  it('rejects a flag that is not a boolean, and an unknown label', () => {
    expect(() => parseExpected({ poi: 'yes' })).toThrow(InvalidExpectedError);
    expect(() => parseExpected({ violence: true })).toThrow(/violence/);
  });

  it("rejects a label outside the entity type's label set when one is given", () => {
    expect(() => parseExpected({ scam: true }, ['nsfw', 'poi', 'minor'])).toThrow(/scam/);
    expect(parseExpected({ scam: true }, ['scam'])).toEqual({ scam: true });
  });
});

describe('composeUserMessage', () => {
  it('joins non-blank fields as "## heading\\ntext", trimmed, like production', () => {
    expect(
      composeUserMessage([
        { heading: 'Name', text: ' My LoRA ' },
        { heading: 'Empty', text: '  ' },
        { heading: 'Version', text: 'v1 notes' },
      ])
    ).toBe('## Name\nMy LoRA\n\n## Version\nv1 notes');
  });
});

describe('expectedChips', () => {
  it('gives one chip per scored label', () => {
    expect(expectedChips({ nsfw: { min: 'pg13', max: 'r' }, poi: false })).toEqual([
      'nsfw pg13–r',
      'poi no',
    ]);
    expect(expectedChips({ nsfw: { min: 'x', max: 'x' }, scam: true })).toEqual([
      'nsfw x',
      'scam yes',
    ]);
  });
});
