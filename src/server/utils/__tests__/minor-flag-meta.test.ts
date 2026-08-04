import { describe, expect, it } from 'vitest';
import {
  filterModelMetaForClient,
  isMinorAutoFlagged,
  stripMinorHashMeta,
} from '~/server/utils/minor-flag-meta';
import type { MinorFlagSnapshot, ModelMeta } from '~/server/schema/model.schema';

const snapshot = (over: Partial<MinorFlagSnapshot> = {}): MinorFlagSnapshot => ({
  at: '2026-07-30T00:00:00.000Z',
  source: 'auto',
  prevMinorImageIds: [1, 2, 3],
  ...over,
});

describe('isMinorAutoFlagged', () => {
  it('is true for a raw automated flag', () => {
    expect(isMinorAutoFlagged({ minorFlagSnapshot: snapshot() })).toBe(true);
  });

  it('stays true after a moderator confirms it and source flips to manual', () => {
    // confirmMinorHashAutoFlag rewrites source but preserves the origin in confirmedFrom.
    expect(
      isMinorAutoFlagged({
        minorFlagSnapshot: snapshot({ source: 'manual', confirmedFrom: 'auto' }),
      })
    ).toBe(true);
  });

  it('is false for a genuine manual flag', () => {
    expect(isMinorAutoFlagged({ minorFlagSnapshot: snapshot({ source: 'manual' }) })).toBe(false);
  });

  it('is false for a legacy flag with no snapshot, and for null/undefined meta', () => {
    expect(isMinorAutoFlagged({})).toBe(false);
    expect(isMinorAutoFlagged(null)).toBe(false);
    expect(isMinorAutoFlagged(undefined)).toBe(false);
  });
});

describe('stripMinorHashMeta', () => {
  const full: ModelMeta = {
    unpublishedReason: 'other',
    minorFlagSnapshot: snapshot(),
    minorHashDismissed: { at: '2026-07-30T00:00:00.000Z', by: 7 },
    minorHashCleared: { at: '2026-07-30T00:00:00.000Z' },
    profanityMatches: ['badword'],
  };

  it('removes all three minor-hash keys', () => {
    const result = stripMinorHashMeta(full);
    expect(result).not.toHaveProperty('minorFlagSnapshot');
    expect(result).not.toHaveProperty('minorHashDismissed');
    expect(result).not.toHaveProperty('minorHashCleared');
  });

  it('leaves every other key untouched — including profanityMatches', () => {
    // Profanity filtering is filterModelMetaForClient's job, not this one's.
    const result = stripMinorHashMeta(full);
    expect(result.unpublishedReason).toBe('other');
    expect(result.profanityMatches).toEqual(['badword']);
  });

  it('does not mutate the input', () => {
    const input: ModelMeta = {
      minorFlagSnapshot: snapshot(),
      minorHashDismissed: { at: '2026-07-30T00:00:00.000Z', by: 7 },
      minorHashCleared: { at: '2026-07-30T00:00:00.000Z' },
    };
    stripMinorHashMeta(input);
    expect(input.minorFlagSnapshot).toBeDefined();
    expect(input.minorHashDismissed).toBeDefined();
    expect(input.minorHashCleared).toBeDefined();
  });

  it('passes null through', () => {
    expect(stripMinorHashMeta(null)).toBeNull();
  });

  it('is a no-op for meta that carries none of the keys', () => {
    expect(stripMinorHashMeta({ unpublishedReason: 'other' })).toEqual({
      unpublishedReason: 'other',
    });
  });
});

describe('filterModelMetaForClient', () => {
  const full: ModelMeta = {
    unpublishedReason: 'other',
    minorFlagSnapshot: snapshot(),
    minorHashDismissed: { at: '2026-07-30T00:00:00.000Z', by: 7 },
    minorHashCleared: { at: '2026-07-30T00:00:00.000Z' },
    profanityMatches: ['badword'],
  };

  it('strips all three minor-hash keys for a normal user', () => {
    const result = filterModelMetaForClient(full, false);
    expect(result.minorFlagSnapshot).toBeUndefined();
    expect(result.minorHashDismissed).toBeUndefined();
    expect(result.minorHashCleared).toBeUndefined();
  });

  it('strips them for moderators too', () => {
    // The moderator UI reads these through its own procedures, never model.getById.
    const result = filterModelMetaForClient(full, true);
    expect(result.minorFlagSnapshot).toBeUndefined();
    expect(result.minorHashDismissed).toBeUndefined();
    expect(result.minorHashCleared).toBeUndefined();
  });

  it('keeps unrelated meta keys intact', () => {
    expect(filterModelMetaForClient(full, false).unpublishedReason).toBe('other');
  });

  it('still applies profanity filtering: hidden for users, kept for moderators', () => {
    expect(filterModelMetaForClient(full, false).profanityMatches).toBeUndefined();
    expect(filterModelMetaForClient(full, true).profanityMatches).toEqual(['badword']);
  });

  it('does not mutate the input', () => {
    const input: ModelMeta = { minorFlagSnapshot: snapshot() };
    filterModelMetaForClient(input, false);
    expect(input.minorFlagSnapshot).toBeDefined();
  });
});

describe('stripMinorHashMeta — accepted stamp', () => {
  // It records that a moderator queue let the flag stand, same class of
  // information as the dismissal and clear stamps.
  it('removes minorHashAccepted', () => {
    const meta = {
      minorHashAccepted: { at: '2026-08-04T00:00:00.000Z' },
      description: 'kept',
    } as ModelMeta;

    const result = stripMinorHashMeta(meta);

    expect(result).not.toHaveProperty('minorHashAccepted');
    expect(result).toHaveProperty('description', 'kept');
  });
});
