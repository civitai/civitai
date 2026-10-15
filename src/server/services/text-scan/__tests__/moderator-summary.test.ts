import { describe, expect, it } from 'vitest';
import {
  summarizeTextScan,
  textScanLabelDetected,
} from '~/server/services/text-scan/moderator-summary';

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

  it('surfaces a cut and a segmented scan from the result meta', () => {
    const summary = summarizeTextScan({
      status: 'Succeeded',
      nsfwLevel: 1,
      triggeredLabels: [],
      result: {
        version: 1,
        labels: { nsfw: { level: 'none', reason: 'Clean.' } },
        promptIds: { base: 1 },
        model: 'm',
        meta: { inputChars: 3_000_000, inputCut: true, segments: 10, scannedChars: 1_990_000 },
      },
      updatedAt: at,
    });
    expect(summary).toMatchObject({ inputCut: true, segments: 10 });
  });

  it('adds nothing for a one-segment row', () => {
    const summary = summarizeTextScan({
      status: 'Succeeded',
      nsfwLevel: 1,
      triggeredLabels: [],
      result: {
        version: 1,
        labels: { nsfw: { level: 'none', reason: 'Clean.' } },
        promptIds: { base: 1 },
        model: 'm',
        meta: { inputChars: 10, inputCut: false, segments: 1, scannedChars: 10 },
      },
      updatedAt: at,
    });
    expect(summary).not.toHaveProperty('inputCut');
    expect(summary).not.toHaveProperty('segments');
  });
});

describe('textScanLabelDetected', () => {
  const result = {
    version: 1,
    labels: { poi: { detected: true, reason: 'r' }, minor: { detected: 'yes', reason: 'r' } },
  };

  it('reads a boolean detected for the label', () => {
    expect(textScanLabelDetected(result, 'poi')).toBe(true);
  });

  it('is null for a non-boolean detected, a missing label, or no result', () => {
    expect(textScanLabelDetected(result, 'minor')).toBeNull();
    expect(textScanLabelDetected(result, 'nsfw')).toBeNull();
    expect(textScanLabelDetected(null, 'poi')).toBeNull();
  });
});
