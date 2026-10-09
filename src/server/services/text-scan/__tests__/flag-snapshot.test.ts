import { describe, expect, it } from 'vitest';
import {
  appealGrantCoversText,
  buildTextScanFlagEntry,
  hasOpenTextScanFlag,
  hasTextScanVerdict,
  resolveFlagScanReasons,
  isBountyFlagAppealable,
  isModelFlagAppealable,
  isTextScanFlagAppealGranted,
  isTextScanPoiHidden,
  MAX_FLAG_NAMES,
  MAX_FLAG_REASON_CHARS,
  readTextScanFlags,
} from '~/server/services/text-scan/flag-snapshot';

const entry = (over: Record<string, unknown> = {}) => ({
  at: '2026-09-26T00:00:00.000Z',
  workflowId: 'wf-1',
  reason: 'Names a real actor.',
  ...over,
});

describe('readTextScanFlags', () => {
  it.each([null, undefined, 'x', 3, [], { textScanFlags: [] }, { textScanFlags: 'x' }])(
    'returns {} for %j',
    (meta) => expect(readTextScanFlags(meta)).toEqual({})
  );

  it('returns the stored flags', () => {
    const flags = { poi: entry() };
    expect(readTextScanFlags({ textScanFlags: flags, other: 1 })).toEqual(flags);
  });
});

describe('hasOpenTextScanFlag / isTextScanFlagAppealGranted', () => {
  it('is open while the entry exists without a granted appeal', () => {
    expect(hasOpenTextScanFlag({ textScanFlags: { poi: entry() } }, 'poi')).toBe(true);
    expect(hasOpenTextScanFlag({ textScanFlags: { poi: entry() } }, 'minor')).toBe(false);
  });

  it('an upheld appeal leaves the flag open; a granted one closes it', () => {
    const upheld = { textScanFlags: { poi: entry({ appealUpheld: { at: 'x', by: 1 } }) } };
    const granted = { textScanFlags: { poi: entry({ appealGranted: { at: 'x', by: 1 } }) } };
    expect(hasOpenTextScanFlag(upheld, 'poi')).toBe(true);
    expect(hasOpenTextScanFlag(granted, 'poi')).toBe(false);
    expect(isTextScanFlagAppealGranted(granted, 'poi')).toBe(true);
    expect(isTextScanFlagAppealGranted(upheld, 'poi')).toBe(false);
  });
});

describe('appealGrantCoversText', () => {
  const granted = (textHash?: string | null) => ({
    textScanFlags: { poi: entry({ appealGranted: { at: 'x', by: 1, textHash } }) },
  });

  it('covers the text the appeal was granted on', () => {
    expect(appealGrantCoversText(granted('h1'), 'poi', 'h1')).toBe(true);
  });

  it('does not cover edited text', () => {
    expect(appealGrantCoversText(granted('h1'), 'poi', 'h2')).toBe(false);
  });

  // A grant written without a hash must not become a permanent exemption for the label.
  it('never covers when the grant has no hash', () => {
    expect(appealGrantCoversText(granted(null), 'poi', 'h1')).toBe(false);
    expect(appealGrantCoversText(granted(undefined), 'poi', 'h1')).toBe(false);
  });

  it('is false without a grant', () => {
    expect(appealGrantCoversText({ textScanFlags: { poi: entry() } }, 'poi', 'h1')).toBe(false);
  });
});

describe('hasTextScanVerdict', () => {
  it('is true for a scan verdict and false for a ruling stub', () => {
    expect(hasTextScanVerdict({ textScanFlags: { minor: entry() } }, 'minor')).toBe(true);
    const stub = {
      textScanFlags: {
        minor: { appealGranted: { at: 'x', by: 1, textHash: 'h', via: 'moderator' } },
      },
    };
    expect(hasTextScanVerdict(stub, 'minor')).toBe(false);
    expect(hasOpenTextScanFlag(stub, 'minor')).toBe(false);
  });
});

describe('buildTextScanFlagEntry', () => {
  it('caps the reason and the names, trims and dedupes names', () => {
    const built = buildTextScanFlagEntry({
      workflowId: 'wf-1',
      reason: `  ${'r'.repeat(MAX_FLAG_REASON_CHARS + 50)}  `,
      names: [' A ', 'A', '', ...Array.from({ length: 20 }, (_, i) => `N${i}`)],
      textHash: 'h1',
    });
    expect(built.reason).toHaveLength(MAX_FLAG_REASON_CHARS);
    expect(built.names?.[0]).toBe('A');
    expect(built.names).toHaveLength(MAX_FLAG_NAMES);
    expect(new Set(built.names).size).toBe(built.names?.length);
  });

  it('records the flagged text hash and omits names when the label has none', () => {
    expect(buildTextScanFlagEntry({ workflowId: 'wf-1', reason: 'r', textHash: 'h1' })).toEqual({
      workflowId: 'wf-1',
      reason: 'r',
      textHash: 'h1',
    });
  });
});

describe('isModelFlagAppealable', () => {
  it('accepts a minor flag that carries a minor snapshot (hash, manual or text-scan)', () => {
    expect(
      isModelFlagAppealable({ minor: true, poi: false, meta: { minorFlagSnapshot: { at: 'x' } } })
    ).toBe(true);
  });

  // Snapshot capture is best-effort, so a text-scan minor flag must stay appealable without it.
  it('accepts a minor flag with an open text-scan minor verdict and no snapshot', () => {
    expect(
      isModelFlagAppealable({
        minor: true,
        poi: false,
        meta: { textScanFlags: { minor: entry() } },
      })
    ).toBe(true);
  });

  it('rejects a legacy minor flag with no snapshot', () => {
    expect(isModelFlagAppealable({ minor: true, poi: false, meta: {} })).toBe(false);
  });

  it('accepts an open text-scan poi flag on a poi model', () => {
    expect(
      isModelFlagAppealable({ minor: false, poi: true, meta: { textScanFlags: { poi: entry() } } })
    ).toBe(true);
  });

  it('rejects a self-declared poi (no text-scan entry) and a granted one', () => {
    expect(isModelFlagAppealable({ minor: false, poi: true, meta: {} })).toBe(false);
    expect(
      isModelFlagAppealable({
        minor: false,
        poi: true,
        meta: { textScanFlags: { poi: entry({ appealGranted: { at: 'x', by: 1 } }) } },
      })
    ).toBe(false);
  });

  it('rejects when the flag was lifted by other means', () => {
    expect(
      isModelFlagAppealable({ minor: false, poi: false, meta: { textScanFlags: { poi: entry() } } })
    ).toBe(false);
  });
});

describe('isBountyFlagAppealable', () => {
  it('needs poi AND an open text-scan entry', () => {
    expect(isBountyFlagAppealable({ poi: true, meta: { textScanFlags: { poi: entry() } } })).toBe(
      true
    );
    expect(isBountyFlagAppealable({ poi: true, meta: null })).toBe(false);
    expect(isBountyFlagAppealable({ poi: false, meta: { textScanFlags: { poi: entry() } } })).toBe(
      false
    );
  });
});

describe('isTextScanPoiHidden', () => {
  const open = { textScanFlags: { poi: entry() } };

  it('is true only for a Private poi bounty with an open text-scan poi flag', () => {
    expect(isTextScanPoiHidden({ poi: true, availability: 'Private', meta: open })).toBe(true);
    expect(isTextScanPoiHidden({ poi: true, availability: 'Public', meta: open })).toBe(false);
    expect(isTextScanPoiHidden({ poi: false, availability: 'Private', meta: open })).toBe(false);
    expect(isTextScanPoiHidden({ poi: true, availability: 'Private', meta: null })).toBe(false);
    expect(
      isTextScanPoiHidden({
        poi: true,
        availability: 'Private',
        meta: { textScanFlags: { poi: entry({ appealGranted: { at: 'x', by: 1 } }) } },
      })
    ).toBe(false);
  });
});

describe('resolveFlagScanReasons', () => {
  const meta = {
    textScanFlags: {
      poi: { workflowId: 'w1', reason: 'names a real actor', names: ['Jane Doe'] },
      minor: { workflowId: 'w1', reason: 'describes a child' },
    },
  };

  it('gives the owner each open flag reason, minor first, with the poi names', () => {
    expect(resolveFlagScanReasons({ isOwner: true, poi: true, minor: true, meta })).toEqual([
      { label: 'minor', reason: 'describes a child', names: [] },
      { label: 'poi', reason: 'names a real actor', names: ['Jane Doe'] },
    ]);
  });

  it('gives a visitor nothing', () => {
    expect(resolveFlagScanReasons({ isOwner: false, poi: true, minor: true, meta })).toEqual([]);
  });

  it('skips a label whose column is unset, or whose flag an appeal lifted', () => {
    expect(
      resolveFlagScanReasons({ isOwner: true, poi: true, minor: false, meta }).map((r) => r.label)
    ).toEqual(['poi']);
    const granted = {
      textScanFlags: {
        poi: { workflowId: 'w1', reason: 'r', appealGranted: { at: '2026-10-01', by: 4 } },
      },
    };
    expect(
      resolveFlagScanReasons({ isOwner: true, poi: true, minor: false, meta: granted })
    ).toEqual([]);
  });
});
