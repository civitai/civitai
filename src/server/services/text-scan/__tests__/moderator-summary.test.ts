import { describe, expect, it } from 'vitest';
import { summarizeTextScan } from '~/server/services/text-scan/moderator-summary';

const at = new Date('2026-09-26T00:00:00Z');

describe('summarizeTextScan', () => {
  it('lists each label reason from a text-scan row', () => {
    expect(
      summarizeTextScan({
        status: 'Succeeded',
        nsfwLevel: 8,
        triggeredLabels: ['nsfw'],
        result: {
          version: 1,
          labels: {
            nsfw: { level: 'x', reason: 'Describes explicit acts.' },
            poi: { detected: false, names: [], reason: 'No real person.' },
          },
          promptIds: { base: 1 },
          model: 'm',
        },
        updatedAt: at,
      })
    ).toEqual({
      status: 'Succeeded',
      nsfwLevel: 8,
      triggeredLabels: ['nsfw'],
      reasons: [
        { label: 'nsfw', reason: 'Describes explicit acts.' },
        { label: 'poi', reason: 'No real person.' },
      ],
      updatedAt: at,
    });
  });

  it('ignores an XGuard row and a missing row', () => {
    expect(
      summarizeTextScan({
        status: 'Succeeded',
        nsfwLevel: null,
        triggeredLabels: ['nsfw'],
        result: { blocked: false, triggeredLabels: ['nsfw'], results: [] },
        updatedAt: at,
      })
    ).toBeNull();
    expect(summarizeTextScan(null)).toBeNull();
  });
});
