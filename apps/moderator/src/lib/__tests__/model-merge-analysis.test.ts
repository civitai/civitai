import { describe, expect, it } from 'vitest';
import { parseModelLink, reportTitle, type LoraEvidence } from '../model-merge-analysis';

describe('parseModelLink', () => {
  it('reads model, model-with-version, version and AIR links', () => {
    expect(parseModelLink('https://civitai.com/models/4384/dreamshaper')).toEqual({ modelId: 4384 });
    expect(parseModelLink('civitai.com/models/4384?modelVersionId=128713')).toEqual({
      modelId: 4384,
      versionId: 128713,
    });
    expect(parseModelLink('https://civitai.com/model-versions/3284136')).toEqual({
      versionId: 3284136,
    });
    expect(parseModelLink('urn:air:krea2:lora:civitai:2688234@3070702+2949534')).toEqual({
      modelId: 2688234,
      versionId: 3070702,
      fileId: 2949534,
    });
  });

  it('refuses links that do not name a Civitai model', () => {
    for (const input of [
      'https://example.com/models/1',
      'https://civitai.com/images/1',
      'urn:air:sdxl:lora:huggingface:a/b@1',
      'https://civitai.com/models/1?modelVersionId=x',
    ])
      expect(parseModelLink(input)).toHaveProperty('error');
  });
});

describe('reportTitle', () => {
  const candidate = (verdict: string) => ({ verdict }) as LoraEvidence;
  const report = (...verdicts: string[]) => ({
    explainedFraction: null,
    expectedExplainedFraction: 0,
    verificationSamples: 0,
    warnings: [],
    candidates: verdicts.map(candidate),
  });

  it('never turns an inconclusive candidate into a no', () => {
    expect(reportTitle(report('No signal detected', 'Inconclusive'))).toBe('Inconclusive');
    expect(reportTitle(report('No signal detected'))).toBe('No match found for the selected LoRAs');
    expect(reportTitle(report('Inconclusive', 'Supporting evidence'))).toBe('Merge evidence found');
  });
});
