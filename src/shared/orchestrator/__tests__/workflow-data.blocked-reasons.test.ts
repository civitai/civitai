import { describe, expect, it } from 'vitest';

import {
  blockedReasonMessage,
  isCappedBlock,
  NSFW_CAPPED,
  PRIVATE_GEN,
} from '~/shared/orchestrator/workflow-data';

describe('blocked reasons', () => {
  it.each([
    [NSFW_CAPPED, true],
    [PRIVATE_GEN, true],
    ['canUpgrade', false],
    ['siteRestricted', false],
    ['MatureContent', false],
    ['unknownReason', false],
    [undefined, false],
  ])('%s is a rating cap: %s', (reason, capped) => {
    expect(isCappedBlock(reason)).toBe(capped);
  });

  it('names an unknown reason rather than showing nothing', () => {
    expect(blockedReasonMessage('somethingNew')).toBe('Generation blocked: somethingNew.');
  });
});
