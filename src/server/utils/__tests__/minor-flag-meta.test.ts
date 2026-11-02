import { describe, expect, it } from 'vitest';
import {
  filterModelMetaForClient,
  isMinorAutoFlagged,
  resolveMinorAppeal,
  resolveMinorFlagged,
  resolvePoiFlagged,
  stripMinorHashMeta,
  MODERATION_FLOW_META_KEYS,
  stripModerationOwnedMeta,
  pickModerationOwnedMeta,
  pickServerOwnedMeta,
  stripServerOwnedMeta,
  withPrivateCannotPromote,
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
    ownerFlagOverride: {
      at: '2026-07-30T00:00:00.000Z',
      flags: ['minor'],
      prevNsfw: true,
      prevSfwOnly: false,
      prevLockedProperties: ['nsfw'],
    },
  };

  it('removes all three minor-hash keys', () => {
    const result = stripMinorHashMeta(full);
    expect(result).not.toHaveProperty('minorFlagSnapshot');
    expect(result).not.toHaveProperty('minorHashDismissed');
    expect(result).not.toHaveProperty('minorHashCleared');
  });

  it('removes the owner-flag override record', () => {
    expect(stripMinorHashMeta(full)).not.toHaveProperty('ownerFlagOverride');
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

  it('hides which system check locked the rating', () => {
    expect(
      stripMinorHashMeta({ systemNsfwLock: { source: 'text-scan', at: '2026-09-05T00:00:00Z' } })
    ).toEqual({});
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

describe('resolveMinorFlagged', () => {
  const flagged = {
    minor: true,
    meta: { minorFlagSnapshot: { source: 'manual', at: '2026-08-01' } },
  };

  it('is false for a visitor even when the model is flagged', () => {
    expect(resolveMinorFlagged({ isOwner: false, ...flagged })).toBe(false);
  });

  // Seb's feedback: a moderator's manual Set-as-Minor was invisible to the owner.
  it('is true for the owner of a manually flagged model', () => {
    expect(resolveMinorFlagged({ isOwner: true, ...flagged })).toBe(true);
  });

  // The ~13.7k pre-feature flags carry no snapshot and stay on the support path.
  it('is false for a legacy flag with no snapshot', () => {
    expect(resolveMinorFlagged({ isOwner: true, minor: true, meta: {} })).toBe(false);
  });
});

describe('resolveMinorAppeal', () => {
  const appeal = { status: 'Pending', resolvedAt: null };

  // The load-bearing case: a visitor must never learn a model has an appeal in
  // flight, even if the caller forgets to gate the fetch itself.
  it('is null for a non-owner, even when an appeal exists', () => {
    expect(resolveMinorAppeal({ isOwner: false, appeal })).toBeNull();
  });

  it('passes the appeal through for the owner', () => {
    expect(resolveMinorAppeal({ isOwner: true, appeal })).toEqual(appeal);
  });

  it('is null for the owner when there is no appeal', () => {
    expect(resolveMinorAppeal({ isOwner: true, appeal: null })).toBeNull();
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

describe('textModeration redaction', () => {
  const meta = {
    textModeration: {
      matchedTerms: ['some matched phrase'],
      triggeredLabels: ['Suggestive'],
      scannedAt: '2026-08-19T00:00:00.000Z',
    },
    profanityMatches: ['badword'],
  } as ModelMeta;

  // Model.meta reaches clients by TWO paths: filterModelMetaForClient (moderator-aware) and
  // stripMinorHashMeta called directly (model.service.ts:1711,2534 — NOT moderator-aware).
  // The strip has to live in the function both paths share, or the second one leaks.
  it('strips textModeration in stripMinorHashMeta itself', () => {
    expect(stripMinorHashMeta(meta).textModeration).toBeUndefined();
  });

  it('strips it for moderators too — the moderator surface is getModelModerationDetail, which does not use this path', () => {
    expect(filterModelMetaForClient(meta, true).textModeration).toBeUndefined();
    expect(filterModelMetaForClient(meta, false).textModeration).toBeUndefined();
  });

  it('leaves unrelated keys intact', () => {
    const result = stripMinorHashMeta({ ...meta, showcaseCollectionId: 7 } as ModelMeta);
    expect(result.showcaseCollectionId).toBe(7);
  });
});

// A key that is never safe to hand out is never safe to accept either. `modelUpsertSchema.meta`
// is a looseObject, so without this an owner's save can write these directly.
describe('stripModerationOwnedMeta', () => {
  const meta = {
    textModeration: { matchedTerms: ['t'], triggeredLabels: ['NSFW'], scannedAt: 'x' },
    minorFlagSnapshot: { source: 'auto', at: 'x' },
    ownerFlagOverride: { at: 'x', flags: ['minor'] },
    profanityMatches: ['p'],
    commentsLocked: true,
  } as unknown as ModelMeta;

  it('drops every moderation-owned key for a non-moderator', () => {
    const result = stripModerationOwnedMeta(meta);
    expect(result?.textModeration).toBeUndefined();
    expect(result?.minorFlagSnapshot).toBeUndefined();
    expect(result?.ownerFlagOverride).toBeUndefined();
    expect(result?.profanityMatches).toBeUndefined();
  });

  it('leaves unrelated keys intact', () => {
    expect(stripModerationOwnedMeta(meta)?.commentsLocked).toBe(true);
  });

  it('passes a moderator through untouched', () => {
    expect(stripModerationOwnedMeta(meta, true)).toBe(meta);
  });

  it('covers exactly what stripMinorHashMeta hides, so the two directions cannot drift', () => {
    const outbound = stripMinorHashMeta(meta);
    for (const key of Object.keys(meta)) {
      if ((outbound as Record<string, unknown>)[key] !== undefined) continue;
      expect((stripModerationOwnedMeta(meta) as Record<string, unknown>)[key]).toBeUndefined();
    }
  });

  it('handles null and undefined', () => {
    expect(stripModerationOwnedMeta(null)).toBeNull();
    expect(stripModerationOwnedMeta(undefined)).toBeUndefined();
  });
});
describe('moderation-flow keys', () => {
  const flow = Object.fromEntries(MODERATION_FLOW_META_KEYS.map((key) => [key, 1])) as ModelMeta;
  const meta = { ...flow, hideBuzz: true } as ModelMeta;

  it('are dropped for a non-moderator and kept for a moderator', () => {
    expect(stripModerationOwnedMeta(meta, false)).toEqual({ hideBuzz: true });
    expect(stripModerationOwnedMeta(meta, true)).toBe(meta);
  });

  it('stay visible to the owner on the way out', () => {
    expect(stripMinorHashMeta(meta)).toEqual(meta);
  });
});

describe('textScanFlags is moderation-owned', () => {
  const textScanFlags = {
    poi: { at: 'x', workflowId: 'wf-1', reason: 'Names a real actor.', names: ['Jane Doe'] },
  };

  it('is stripped from every client-facing meta, moderators included', () => {
    const meta = { textScanFlags, commentsLocked: true } as ModelMeta;
    expect(stripMinorHashMeta(meta)).toEqual({ commentsLocked: true });
    expect(filterModelMetaForClient(meta, true)).toEqual({ commentsLocked: true });
  });

  it('cannot be authored by a creator on save', () => {
    const meta = { textScanFlags, commentsLocked: true } as ModelMeta;
    expect(stripModerationOwnedMeta(meta, false)).toEqual({ commentsLocked: true });
    expect(stripModerationOwnedMeta(meta, true)).toEqual(meta);
  });
});

describe('pickModerationOwnedMeta', () => {
  const stored = {
    cannotPublish: true,
    declinedReason: 'x',
    textScanFlags: { poi: { at: 'x', workflowId: 'wf', reason: 'r', names: [] } },
    minorFlagSnapshot: snapshot(),
    commentsLocked: true,
  } as ModelMeta;

  it('returns exactly the moderation-owned and flow keys that are present', () => {
    const picked = pickModerationOwnedMeta(stored);
    expect(Object.keys(picked).sort()).toEqual(
      ['cannotPublish', 'declinedReason', 'minorFlagSnapshot', 'textScanFlags'].sort()
    );
  });

  it('is empty for null and undefined', () => {
    expect(pickModerationOwnedMeta(null)).toEqual({});
    expect(pickModerationOwnedMeta(undefined)).toEqual({});
  });
});

describe('server-only keys', () => {
  const meta = {
    trainingStudioWorkflowId: 'wf',
    restoreCannotPromote: true,
    commentsLocked: true,
  } as ModelMeta;

  it('strips the cannotPromote restore marker from client meta, moderators included', () => {
    expect(stripServerOwnedMeta(meta)).toEqual({ commentsLocked: true });
  });

  it('carries the restore marker across a wholesale meta write', () => {
    expect(pickServerOwnedMeta(meta)).toEqual({
      trainingStudioWorkflowId: 'wf',
      restoreCannotPromote: true,
    });
  });
});

describe('resolvePoiFlagged', () => {
  const meta = {
    textScanFlags: { poi: { at: 'x', workflowId: 'wf-1', reason: 'r' } },
  } as ModelMeta;

  it('is true only for the owner of a poi model with an open text-scan flag', () => {
    expect(resolvePoiFlagged({ isOwner: true, poi: true, meta })).toBe(true);
    expect(resolvePoiFlagged({ isOwner: false, poi: true, meta })).toBe(false);
    expect(resolvePoiFlagged({ isOwner: true, poi: false, meta })).toBe(false);
    expect(resolvePoiFlagged({ isOwner: true, poi: true, meta: {} })).toBe(false);
  });

  // The hash match applies the flag with no text-scan entry; without this the owner has no appeal.
  it('is true for the owner of a model the hash match flagged', () => {
    const hashed = { poiFlagSnapshot: { at: 'x', source: 'auto' } } as ModelMeta;
    expect(resolvePoiFlagged({ isOwner: true, poi: true, meta: hashed })).toBe(true);
    expect(resolvePoiFlagged({ isOwner: false, poi: true, meta: hashed })).toBe(false);
    expect(resolvePoiFlagged({ isOwner: true, poi: false, meta: hashed })).toBe(false);
  });
});

describe('real-person hash keys never reach a client', () => {
  const meta = {
    hideBuzz: true,
    poiFlagSnapshot: { at: 'x', source: 'auto', prevNsfw: true },
    poiHashMatch: { at: 'x', hash: 'ABC' },
    poiHashCleared: { at: 'x' },
  } as ModelMeta;
  const keys = ['poiFlagSnapshot', 'poiHashMatch', 'poiHashCleared'];

  it('a non-moderator model read has none of them', () => {
    const out = filterModelMetaForClient(meta, false);
    for (const key of keys) expect(out).not.toHaveProperty(key);
    expect(out.hideBuzz).toBe(true);
  });

  it('an owner cannot write them through model.upsert', () => {
    const out = stripModerationOwnedMeta(meta, false)!;
    for (const key of keys) expect(out).not.toHaveProperty(key);
  });
});

describe('resolveMinorFlagged — text-scan minor', () => {
  it('shows the owner alert for an open text-scan minor even when the snapshot capture failed', () => {
    const meta = {
      textScanFlags: { minor: { at: 'x', workflowId: 'wf-1', reason: 'r' } },
    } as ModelMeta;
    expect(resolveMinorFlagged({ isOwner: true, minor: true, meta })).toBe(true);
    expect(resolveMinorFlagged({ isOwner: true, minor: false, meta })).toBe(false);
  });
});

describe('withPrivateCannotPromote', () => {
  it('forces cannotPromote on and records a ban in the marker', () => {
    expect(withPrivateCannotPromote({ hideBuzz: true }, true)).toEqual({
      hideBuzz: true,
      cannotPromote: true,
      restoreCannotPromote: true,
    });
  });

  it('forces cannotPromote on and drops a stale marker when not banned', () => {
    const result = withPrivateCannotPromote(
      { cannotPromote: true, restoreCannotPromote: true },
      false
    );
    expect(result).toEqual({ cannotPromote: true });
    expect(result).not.toHaveProperty('restoreCannotPromote');
  });
});
