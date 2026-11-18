import { describe, expect, it } from 'vitest';
import {
  labelCandidates,
  parseModelLink,
  reportTitle,
  type LoraEvidence,
  type MergeReport,
} from '../model-merge-analysis';

describe('parseModelLink', () => {
  it('reads model, model-with-version, version and AIR links', () => {
    expect(parseModelLink('https://civitai.com/models/4384/dreamshaper')).toEqual({
      modelId: 4384,
    });
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

const candidate = (verdict: string, sha256 = '', name = 'backend-name') =>
  ({ verdict, sha256, name } as LoraEvidence);
const report = (...candidates: LoraEvidence[]) =>
  ({
    baseSha256: '',
    checkpointSha256: '',
    expectedExplainedFraction: 0,
    verificationSamples: 0,
    warnings: [],
    candidates,
  } satisfies MergeReport);

describe('reportTitle', () => {
  it('never turns an inconclusive candidate into a no', () => {
    expect(reportTitle(report(candidate('No signal detected'), candidate('Inconclusive')), 2)).toBe(
      'Inconclusive'
    );
    expect(reportTitle(report(candidate('No signal detected')), 1)).toBe(
      'No match found for the selected LoRAs'
    );
    expect(
      reportTitle(report(candidate('Inconclusive'), candidate('Supporting evidence')), 2)
    ).toBe('Merge evidence found');
  });

  it('does not say "no match" for LoRAs the report left out', () => {
    expect(reportTitle(report(candidate('No signal detected')), 2)).toBe('Inconclusive');
  });
});

describe('labelCandidates', () => {
  const labels = {
    checkpoint: 'C',
    baseModel: 'B',
    loras: [
      { label: 'LoRA A', sha256: 'AAAA' },
      { label: 'LoRA B', sha256: 'BBBB' },
    ],
  };

  it('names each verdict by file hash, not by position', () => {
    const { candidates, missing } = labelCandidates(
      report(candidate('Supporting evidence', 'bbbb')),
      labels
    );
    expect(candidates.map((c) => c.label)).toEqual(['LoRA B']);
    expect(missing).toBe(true);
  });

  it('keeps the backend name when no submitted hash matches', () => {
    const { candidates } = labelCandidates(report(candidate('Inconclusive', 'cccc')), labels);
    expect(candidates[0].label).toBe('backend-name');
  });
});
