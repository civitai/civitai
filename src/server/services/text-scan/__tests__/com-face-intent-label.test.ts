import { describe, expect, it } from 'vitest';
import '~/server/services/text-scan/profiles/index';
import { TEXT_SCAN_ENTITY_TYPES } from '~/server/services/text-scan/mode';
import { getTextScanProfile } from '~/server/services/text-scan/profiles';
import { TEXT_SCAN_PROMPT_KEY } from '~/server/services/text-scan/prompt';
import { buildTextScanJsonSchema } from '~/server/services/text-scan/schema';
import { mergeTextScanOutputs } from '~/server/services/text-scan/merge';

const LABEL = 'model-com-face-intent';

describe('the model-com-face-intent label', () => {
  it('has a prompt key a moderator can save', () => {
    expect(TEXT_SCAN_PROMPT_KEY.test(`label:${LABEL}`)).toBe(true);
  });

  it('asks the model for { detected, reason }', () => {
    expect(buildTextScanJsonSchema([LABEL]).properties).toEqual({
      [LABEL]: expect.objectContaining({ required: ['detected', 'reason'] }),
    });
  });

  it('merges segments: any detecting segment detects', () => {
    const merged = mergeTextScanOutputs(
      [{ [LABEL]: { detected: false, reason: 'a' } }, { [LABEL]: { detected: true, reason: 'b' } }],
      [LABEL]
    );
    expect(merged.output[LABEL]).toEqual({ detected: true, reason: 'b' });
  });

  // Decision: the label is only previewed for the .com face gate. No entity scan may request it,
  // or every scanned entity would start paying for it and recording verdicts nobody reads.
  it('is requested by no entity scan profile', () => {
    for (const entityType of TEXT_SCAN_ENTITY_TYPES) {
      const labels: readonly string[] = getTextScanProfile(entityType)?.labels ?? [];
      expect(labels, entityType).not.toContain(LABEL);
    }
  });
});
