import { describe, expect, it } from 'vitest';
import { buildSignalState, type ScanOutputInput } from '../signal-state';

// Shaped like a real scan output, including fields the builder must not forward.
const raw = {
  nsfwLevel: 'r',
  csam: true,
  aiRecognition: { label: 'ai', score: 0.987 },
  animeRecognition: { label: 'anime', score: 0.5 },
  tagging: {
    tags: [
      { tag: 'outdoors', category: 'general', score: 0.71 },
      { tag: 'some_character', category: 'character', score: 0.99 },
    ],
  },
  humanRecognition: { ran: true, label: 'human', score: 0.93, evidence: ['x'] },
  jointAgeClassification: {
    ran: true,
    detections: [
      {
        boundingBox: [0, 0, 50, 100],
        domain: 'anime',
        animeProbability: 0.912,
        apparentAge: 15,
        ageBand: '13-17',
        under18Probability: 0.876,
        isMinor: true,
        isOod: false,
        ordinalCutpointProbabilities: { a: 1 },
      },
    ],
    minorDetected: true,
  },
  futureField: 'not allowlisted',
};
const scan: ScanOutputInput = raw;

describe('buildSignalState', () => {
  // Decision: the CSAM scanner verdict is never model input (A4). The builder is an allowlist so a
  // field added to the scan output stays out until someone decides it belongs. Do not replace it
  // with a spread-and-delete.
  it('never carries the CSAM verdict, or any field it was not told to carry', () => {
    const json = JSON.stringify(buildSignalState(scan, { width: 100, height: 200 }));
    expect(json).not.toMatch(/csam/i);
    expect(json).not.toContain('futureField');
    expect(json).not.toContain('ordinalCutpointProbabilities');
  });

  it('carries the allowlisted signals, rounded, with boxes made relative', () => {
    const s = buildSignalState(scan, { width: 100, height: 200 });
    expect(s.rating).toBe('r');
    expect(s.tags).toEqual([{ tag: 'outdoors', score: 0.71 }]);
    expect(s.style.ai).toEqual({ label: 'ai', score: 0.99 });
    expect(s.human).toEqual({ label: 'human', score: 0.93 });
    expect(s.age?.detections[0]).toMatchObject({
      box: [0, 0, 0.5, 0.5],
      under18Probability: 0.88,
      isMinor: true,
    });
  });

  it('drops boxes when the image size is unknown rather than passing pixel coordinates', () => {
    expect(buildSignalState(scan).age?.detections[0].box).toBeNull();
  });
});
