import { describe, expect, it } from 'vitest';
import {
  priorityForSlot,
  sortInstallsForSlot,
  tabLabelFor,
} from '../sortInstallsForSlot';
import type { BlockInstall } from '../types';

/**
 * Pure unit tests for the W8 multi-block ordering rule. The companion
 * `BlockSlotClient` integration cases (loading/error/0/1/n DOM shape) aren't
 * covered here because vitest is configured to include `*.test.ts` only —
 * .tsx component tests need RTL + jsdom + a config change. Instead, we cover
 * the ordering logic exhaustively in pure-TS land so the dynamic behaviour
 * in BlockSlotClient.tsx reduces to "render whatever sortInstallsForSlot
 * returns".
 */

function install(
  partial: Partial<BlockInstall> & { blockInstanceId: string },
  manifestExtras: Record<string, unknown> = {}
): BlockInstall {
  return {
    blockInstanceId: partial.blockInstanceId,
    blockId: partial.blockId ?? 'b',
    appId: partial.appId ?? 'oc',
    appBlockId: partial.appBlockId ?? 'apb',
    manifest: { name: 'Block', ...manifestExtras } as BlockInstall['manifest'],
    publisherSettings: partial.publisherSettings ?? {},
    enabled: partial.enabled ?? true,
    renderMode: partial.renderMode ?? 'iframe',
    trustTier: partial.trustTier ?? 'unverified',
  };
}

describe('priorityForSlot', () => {
  it('returns the matching target priority', () => {
    const i = install(
      { blockInstanceId: 'bki_a' },
      { targets: [{ slotId: 'model.sidebar_top', priority: 750 }] }
    );
    expect(priorityForSlot(i, 'model.sidebar_top')).toBe(750);
  });

  it('returns 0 when manifest has no targets array', () => {
    const i = install({ blockInstanceId: 'bki_a' }, { name: 'A' });
    expect(priorityForSlot(i, 'model.sidebar_top')).toBe(0);
  });

  it('returns 0 when targets is not an array', () => {
    const i = install({ blockInstanceId: 'bki_a' }, { targets: 'oops' });
    expect(priorityForSlot(i, 'model.sidebar_top')).toBe(0);
  });

  it('returns 0 when target for slot lacks priority', () => {
    const i = install(
      { blockInstanceId: 'bki_a' },
      { targets: [{ slotId: 'model.sidebar_top' }] }
    );
    expect(priorityForSlot(i, 'model.sidebar_top')).toBe(0);
  });

  it('returns 0 when no target matches the slot', () => {
    const i = install(
      { blockInstanceId: 'bki_a' },
      { targets: [{ slotId: 'model.below_images', priority: 999 }] }
    );
    expect(priorityForSlot(i, 'model.sidebar_top')).toBe(0);
  });

  it('skips malformed entries before finding a real match', () => {
    const i = install(
      { blockInstanceId: 'bki_a' },
      {
        targets: [
          null,
          'string',
          { priority: 5 }, // no slotId
          { slotId: 'model.sidebar_top', priority: 200 },
        ],
      }
    );
    expect(priorityForSlot(i, 'model.sidebar_top')).toBe(200);
  });

  it('returns 0 for non-finite priorities (NaN / Infinity)', () => {
    const nan = install(
      { blockInstanceId: 'bki_a' },
      { targets: [{ slotId: 's', priority: Number.NaN }] }
    );
    const inf = install(
      { blockInstanceId: 'bki_b' },
      { targets: [{ slotId: 's', priority: Number.POSITIVE_INFINITY }] }
    );
    expect(priorityForSlot(nan, 's')).toBe(0);
    expect(priorityForSlot(inf, 's')).toBe(0);
  });
});

describe('tabLabelFor', () => {
  it('returns the manifest name when present', () => {
    const i = install({ blockInstanceId: 'bki_a' }, { name: 'Hello World' });
    expect(tabLabelFor(i)).toBe('Hello World');
  });

  it('falls back to blockInstanceId when manifest name is missing', () => {
    const i = install({ blockInstanceId: 'bki_alpha' }, { name: undefined });
    expect(tabLabelFor(i)).toBe('bki_alpha');
  });

  it('falls back to blockInstanceId when manifest name is empty string', () => {
    const i = install({ blockInstanceId: 'bki_alpha' }, { name: '' });
    expect(tabLabelFor(i)).toBe('bki_alpha');
  });

  it('falls back to blockInstanceId when manifest name is a non-string', () => {
    const i = install({ blockInstanceId: 'bki_alpha' }, { name: 123 as unknown as string });
    expect(tabLabelFor(i)).toBe('bki_alpha');
  });
});

describe('sortInstallsForSlot', () => {
  const slot = 'model.sidebar_top';

  it('returns empty array unchanged', () => {
    expect(sortInstallsForSlot([], slot)).toEqual([]);
  });

  it('returns single-element list unchanged', () => {
    const i = install({ blockInstanceId: 'bki_solo' }, { name: 'Solo' });
    expect(sortInstallsForSlot([i], slot)).toEqual([i]);
  });

  it('orders by priority desc', () => {
    const low = install(
      { blockInstanceId: 'bki_low' },
      { name: 'Low', targets: [{ slotId: slot, priority: 100 }] }
    );
    const high = install(
      { blockInstanceId: 'bki_high' },
      { name: 'High', targets: [{ slotId: slot, priority: 900 }] }
    );
    const mid = install(
      { blockInstanceId: 'bki_mid' },
      { name: 'Mid', targets: [{ slotId: slot, priority: 500 }] }
    );
    const result = sortInstallsForSlot([low, high, mid], slot);
    expect(result.map((r) => r.blockInstanceId)).toEqual(['bki_high', 'bki_mid', 'bki_low']);
  });

  it('uses manifest.name ascending as the tiebreaker when priorities tie', () => {
    const beta = install(
      { blockInstanceId: 'bki_beta' },
      { name: 'Beta', targets: [{ slotId: slot, priority: 500 }] }
    );
    const alpha = install(
      { blockInstanceId: 'bki_alpha' },
      { name: 'Alpha', targets: [{ slotId: slot, priority: 500 }] }
    );
    const result = sortInstallsForSlot([beta, alpha], slot);
    expect(result.map((r) => r.blockInstanceId)).toEqual(['bki_alpha', 'bki_beta']);
  });

  it('treats missing priorities as 0 alongside explicit 0', () => {
    const noTargets = install({ blockInstanceId: 'bki_none' }, { name: 'NoTargets' });
    const explicitZero = install(
      { blockInstanceId: 'bki_zero' },
      { name: 'AAA', targets: [{ slotId: slot, priority: 0 }] }
    );
    const positive = install(
      { blockInstanceId: 'bki_pos' },
      { name: 'ZZZ', targets: [{ slotId: slot, priority: 1 }] }
    );
    // ZZZ priority 1 wins; AAA & NoTargets both 0, AAA sorts before NoTargets.
    const result = sortInstallsForSlot([noTargets, explicitZero, positive], slot);
    expect(result.map((r) => r.blockInstanceId)).toEqual([
      'bki_pos',
      'bki_zero',
      'bki_none',
    ]);
  });

  it('uses the slot-specific priority — a different slot in targets is ignored', () => {
    const a = install(
      { blockInstanceId: 'bki_a' },
      {
        name: 'A',
        targets: [
          { slotId: 'model.below_images', priority: 999 },
          { slotId: slot, priority: 50 },
        ],
      }
    );
    const b = install(
      { blockInstanceId: 'bki_b' },
      {
        name: 'B',
        targets: [{ slotId: slot, priority: 100 }],
      }
    );
    const result = sortInstallsForSlot([a, b], slot);
    // b (slot priority 100) should beat a (slot priority 50) — a's higher
    // 'model.below_images' priority must not influence the sidebar slot.
    expect(result.map((r) => r.blockInstanceId)).toEqual(['bki_b', 'bki_a']);
  });

  it('is stable when both priority and name match (preserves input order)', () => {
    const a = install({ blockInstanceId: 'bki_first' }, { name: 'Same' });
    const b = install({ blockInstanceId: 'bki_second' }, { name: 'Same' });
    const result = sortInstallsForSlot([a, b], slot);
    expect(result.map((r) => r.blockInstanceId)).toEqual(['bki_first', 'bki_second']);
  });

  it('does not mutate the input array', () => {
    const a = install(
      { blockInstanceId: 'bki_a' },
      { name: 'Beta', targets: [{ slotId: slot, priority: 100 }] }
    );
    const b = install(
      { blockInstanceId: 'bki_b' },
      { name: 'Alpha', targets: [{ slotId: slot, priority: 500 }] }
    );
    const input = [a, b];
    const result = sortInstallsForSlot(input, slot);
    expect(input).toEqual([a, b]); // input unchanged
    expect(result).not.toBe(input);
  });
});
