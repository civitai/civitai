import { describe, expect, it } from 'vitest';
import {
  INACTIVE_OWNER_REFUSAL,
  MODERATION_BLOCK_REFUSAL,
  ingestionResolveRefusal,
} from '../image-ingestion';

const ACTIVE = { blockedFor: null, needsReview: null, ownerBannedAt: null, ownerDeletedAt: null };
const AT = new Date('2026-01-01T00:00:00Z');

describe('ingestionResolveRefusal', () => {
  it.each([
    'CSAM',
    'csam',
    'moderated',
    ' Moderated ',
    'tos',
    'TOS',
    'AiNotVerified',
    'ainotverified',
  ])('refuses blockedFor %j as a moderation block', (blockedFor) => {
    expect(ingestionResolveRefusal({ ...ACTIVE, blockedFor })).toBe(MODERATION_BLOCK_REFUSAL);
  });

  it('refuses a csam review hold, whatever the block reason', () => {
    expect(ingestionResolveRefusal({ ...ACTIVE, needsReview: 'csam' })).toBe(
      MODERATION_BLOCK_REFUSAL
    );
    expect(
      ingestionResolveRefusal({
        ...ACTIVE,
        needsReview: 'csam',
        blockedFor: 'a prompt audit reason',
      })
    ).toBe(MODERATION_BLOCK_REFUSAL);
  });

  it('refuses when the owner is banned or deleted', () => {
    expect(ingestionResolveRefusal({ ...ACTIVE, ownerBannedAt: AT })).toBe(INACTIVE_OWNER_REFUSAL);
    expect(ingestionResolveRefusal({ ...ACTIVE, ownerDeletedAt: AT })).toBe(INACTIVE_OWNER_REFUSAL);
  });

  it('allows a scan-set block or no block, with an active owner', () => {
    expect(ingestionResolveRefusal({ ...ACTIVE, blockedFor: 'a prompt audit reason' })).toBeNull();
    expect(ingestionResolveRefusal({ ...ACTIVE, needsReview: 'minor' })).toBeNull();
    expect(ingestionResolveRefusal(ACTIVE)).toBeNull();
  });
});
