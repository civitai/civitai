import { describe, expect, it } from 'vitest';
import { mergeTextScanOutputs, stricterThanStored } from '~/server/services/text-scan/merge';
import type { TextScanOutput } from '~/server/services/text-scan/types';

describe('mergeTextScanOutputs', () => {
  it('returns a single output unchanged, with no provenance', () => {
    const only: TextScanOutput = {
      nsfw: { level: 'r', reason: 'Invented reason.' },
      poi: { detected: false, names: ['Kept As Is', 'kept as is'], reason: 'None.' },
    };
    const merged = mergeTextScanOutputs([only], ['nsfw', 'poi']);
    expect(merged.output).toBe(only);
    expect(merged.flaggedSegments).toEqual({});
  });

  it('takes the highest nsfw level and the reason of the first segment at it', () => {
    expect(
      mergeTextScanOutputs(
        [
          { nsfw: { level: 'r', reason: 'r0' } },
          { nsfw: { level: 'x', reason: 'x1' } },
          { nsfw: { level: 'x', reason: 'x2' } },
        ],
        ['nsfw']
      )
    ).toEqual({
      output: { nsfw: { level: 'x', reason: 'x1' } },
      flaggedSegments: { nsfw: [1, 2] },
    });
  });

  it('does not flag nsfw when every segment is none', () => {
    expect(
      mergeTextScanOutputs(
        [{ nsfw: { level: 'none', reason: 'n0' } }, { nsfw: { level: 'none', reason: 'n1' } }],
        ['nsfw']
      )
    ).toEqual({ output: { nsfw: { level: 'none', reason: 'n0' } }, flaggedSegments: {} });
  });

  it('detects poi if any segment does, unioning names case-insensitively', () => {
    expect(
      mergeTextScanOutputs(
        [
          { poi: { detected: false, names: ['Not Counted'], reason: 'p0' } },
          { poi: { detected: true, names: ['Jane Doe', 'Sam Roe'], reason: 'p1' } },
          { poi: { detected: true, names: ['jane doe ', 'Alex Poe'], reason: 'p2' } },
        ],
        ['poi']
      )
    ).toEqual({
      output: { poi: { detected: true, names: ['Jane Doe', 'Sam Roe', 'Alex Poe'], reason: 'p1' } },
      flaggedSegments: { poi: [1, 2] },
    });
  });

  it('an overlap seen twice yields one scam reason, never two joined', () => {
    const merged = mergeTextScanOutputs(
      [
        { scam: { detected: true, reason: 'Asks for gift card codes.' } },
        { scam: { detected: true, reason: 'Repeats the gift card request.' } },
      ],
      ['scam']
    );
    expect(merged.output.scam).toEqual({ detected: true, reason: 'Asks for gift card codes.' });
    expect(merged.flaggedSegments).toEqual({ scam: [0, 1] });
  });

  it('takes the reason of segment 0 when no segment detects minor', () => {
    expect(
      mergeTextScanOutputs(
        [
          { minor: { detected: false, reason: 'm0' } },
          { minor: { detected: false, reason: 'm1' } },
        ],
        ['minor']
      )
    ).toEqual({ output: { minor: { detected: false, reason: 'm0' } }, flaggedSegments: {} });
  });

  it('takes the reason of the first detecting segment for minor', () => {
    expect(
      mergeTextScanOutputs(
        [{ minor: { detected: false, reason: 'm0' } }, { minor: { detected: true, reason: 'm1' } }],
        ['minor']
      ).output.minor
    ).toEqual({ detected: true, reason: 'm1' });
  });

  it('records flaggedSegments even when only one of several segments flagged', () => {
    expect(
      mergeTextScanOutputs(
        [
          { scam: { detected: false, reason: 's0' } },
          { scam: { detected: true, reason: 's1' } },
          { scam: { detected: false, reason: 's2' } },
        ],
        ['scam']
      ).flaggedSegments
    ).toEqual({ scam: [1] });
  });

  it('detects csam if any segment does, with that segment flagged', () => {
    expect(
      mergeTextScanOutputs(
        [{ csam: { detected: false, reason: 'c0' } }, { csam: { detected: true, reason: 'c1' } }],
        ['csam']
      )
    ).toEqual({
      output: { csam: { detected: true, reason: 'c1' } },
      flaggedSegments: { csam: [1] },
    });
  });

  it('outputs only the requested labels', () => {
    const merged = mergeTextScanOutputs(
      [
        { nsfw: { level: 'none', reason: 'a' }, scam: { detected: true, reason: 'b' } },
        { nsfw: { level: 'none', reason: 'c' }, scam: { detected: false, reason: 'd' } },
      ],
      ['nsfw']
    );
    expect(Object.keys(merged.output)).toEqual(['nsfw']);
  });

  it('refuses an empty list', () => {
    expect(() => mergeTextScanOutputs([], ['nsfw'])).toThrow();
  });
});

describe('stricterThanStored', () => {
  const output = {
    nsfw: { level: 'r' as const, reason: 'r' },
    poi: { detected: true, names: ['A'], reason: 'p' },
    minor: { detected: false, reason: 'm' },
    scam: { detected: true, reason: 's' },
  };
  const all = ['nsfw', 'poi', 'minor', 'scam'] as const;

  it('keeps a higher nsfw level and flags not already raised', () => {
    expect(stricterThanStored({ nsfwLevel: 2, triggeredLabels: [] }, output, all)).toEqual([
      'nsfw',
      'poi',
      'scam',
    ]);
  });

  it('raises a detected csam unless it is already stored', () => {
    const csam = { csam: { detected: true, reason: 'test' } };
    const stored = { nsfwLevel: null, triggeredLabels: [] as string[] };
    expect(stricterThanStored(stored, csam, ['csam'])).toEqual(['csam']);
    expect(
      stricterThanStored(stored, { csam: { detected: false, reason: 'test' } }, ['csam'])
    ).toEqual([]);
    expect(stricterThanStored({ ...stored, labels: csam }, csam, ['csam'])).toEqual([]);
  });

  it('drops an equal or lower level, a PG level, and a flag stored in either field', () => {
    expect(
      stricterThanStored(
        { nsfwLevel: 4, triggeredLabels: ['scam'], labels: { poi: output.poi } },
        output,
        all
      )
    ).toEqual([]);
    expect(
      stricterThanStored(
        { nsfwLevel: null, triggeredLabels: [] },
        { nsfw: { level: 'none', reason: '' } },
        ['nsfw']
      )
    ).toEqual([]);
  });
});
