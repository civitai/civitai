import { describe, expect, it } from 'vitest';
import {
  animaControlNetPreprocessors,
  controlNetPreprocessors,
  fluxControlNetPreprocessors,
  getControlNetPreprocessorExamples,
  sd1ControlNetPreprocessors,
  sdxlControlNetPreprocessors,
  zImageControlNetPreprocessors,
} from '~/shared/constants/controlnets.constants';
import type { ControlNetEntryValue } from '~/shared/generation/values';
import { buildControlNetSteps, mapControlNetsToJobInput } from '../handlers/controlnets.helper';

const entry: ControlNetEntryValue = {
  preprocessor: 'sdpose',
  mode: 'auto',
  image: { url: 'https://example.com/pose.png' },
  weight: 0.8,
  startStep: 0.1,
  endStep: 0.9,
};

describe('SDPose ControlNet', () => {
  it.each([
    ['SD1', sd1ControlNetPreprocessors],
    ['SDXL', sdxlControlNetPreprocessors],
    ['Flux', fluxControlNetPreprocessors],
    ['Z Image', zImageControlNetPreprocessors],
    ['Anima', animaControlNetPreprocessors],
  ] as const)('recommends SDPose for %s without removing DWPose', (_, preprocessors) => {
    expect(preprocessors).toContain('dwpose');
    expect(
      preprocessors.filter(
        (key) =>
          controlNetPreprocessors[key].category === 'pose' &&
          controlNetPreprocessors[key].recommended
      )
    ).toEqual(['sdpose']);
  });

  it('runs SDPose preprocessing and passes its output to the existing pose ControlNet', () => {
    const result = buildControlNetSteps([entry], 3);

    expect(result.preprocessSteps).toEqual([
      {
        $type: 'preprocessImage',
        input: { kind: 'sdpose', image: entry.image.url },
        metadata: { suppressOutput: true },
      },
    ]);
    expect(result.controlNets).toEqual([
      {
        preprocessor: 'dwpose',
        image: { $ref: '$3', path: 'output.blob.url' },
        weight: entry.weight,
        startStep: entry.startStep,
        endStep: entry.endStep,
      },
    ]);
  });

  it.each(['dwpose', 'openpose'])('preserves explicit %s selections', (preprocessor) => {
    const result = buildControlNetSteps([{ ...entry, preprocessor }], 0);

    expect(result.preprocessSteps[0].input).toMatchObject({ kind: preprocessor });
    expect(result.controlNets[0].preprocessor).toBe(preprocessor);
  });

  it('does not preprocess an already processed SDPose guide', () => {
    const entries = [{ ...entry, mode: 'preprocessed' as const }];
    const result = buildControlNetSteps(entries, 0);

    expect(result.preprocessSteps).toEqual([]);
    expect(result.controlNets[0]).toMatchObject({ preprocessor: 'dwpose', image: entry.image.url });
    expect(mapControlNetsToJobInput(entries)).toEqual(result.controlNets);
  });

  it('does not link to a missing SDPose example image', () => {
    expect(getControlNetPreprocessorExamples('sdpose')).toEqual([]);
  });
});
